import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Evaluator, Identity, ResolvedPermission } from '@agentic-obs/common';
import type {
  IOpsConnectorRepository,
  NewOpsConnector,
  OpsConnector,
  OpsConnectorPatch,
  OpsConnectorReadOptions,
} from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { createOpsConnectorsRouter } from './ops-connectors.js';

function makeAccessControl(): AccessControlSurface {
  return {
    getUserPermissions: async (): Promise<ResolvedPermission[]> => [],
    ensurePermissions: async (): Promise<ResolvedPermission[]> => [],
    evaluate: async (_id: Identity, _evaluator: Evaluator): Promise<boolean> => true,
    filterByPermission: async <T>(): Promise<T[]> => [],
  };
}

class MemoryOpsConnectorRepository implements IOpsConnectorRepository {
  private readonly rows = new Map<string, OpsConnector>();

  async listByOrg(orgId: string, opts: OpsConnectorReadOptions = {}): Promise<OpsConnector[]> {
    return [...this.rows.values()]
      .filter((row) => row.orgId === orgId)
      .map((row) => mask(row, opts));
  }

  async findByIdInOrg(
    orgId: string,
    id: string,
    opts: OpsConnectorReadOptions = {},
  ): Promise<OpsConnector | null> {
    const row = this.rows.get(id);
    return row?.orgId === orgId ? mask(row, opts) : null;
  }

  async create(input: NewOpsConnector): Promise<OpsConnector> {
    const now = new Date().toISOString();
    const row: OpsConnector = {
      id: input.id ?? `k8s-${this.rows.size + 1}`,
      orgId: input.orgId,
      type: 'kubernetes',
      name: input.name,
      environment: input.environment ?? null,
      config: input.config ?? {},
      secretRef: input.secretRef ?? null,
      secret: input.secret ?? null,
      allowedNamespaces: input.allowedNamespaces ?? [],
      capabilities: input.capabilities ?? [],
      status: input.status ?? 'unknown',
      lastCheckedAt: input.lastCheckedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async update(orgId: string, id: string, patch: OpsConnectorPatch): Promise<OpsConnector | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.orgId !== orgId) return null;
    const updated: OpsConnector = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const existing = this.rows.get(id);
    if (!existing || existing.orgId !== orgId) return false;
    this.rows.delete(id);
    return true;
  }
}

function mask(row: OpsConnector, opts: OpsConnectorReadOptions): OpsConnector {
  return opts.masked && row.secret ? { ...row, secret: '••••••' } : { ...row };
}

function makeApp(repo: IOpsConnectorRepository, orgId = 'org_a') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { auth?: Identity }).auth = {
      userId: 'u_1',
      orgId,
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  });
  app.use('/api/ops/connectors', createOpsConnectorsRouter({
    connectors: repo,
    ac: makeAccessControl(),
  }));
  return app;
}

describe('ops connectors routes', () => {
  const prevSecret = process.env['SECRET_KEY'];
  let repo: MemoryOpsConnectorRepository;

  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-ops-connector-routes-xxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  beforeEach(() => {
    repo = new MemoryOpsConnectorRepository();
  });

  it('creates and lists connectors in the authenticated org', async () => {
    const app = makeApp(repo, 'org_a');

    const created = await request(app)
      .post('/api/ops/connectors')
      .send({
        id: 'k8s-a',
        name: 'Prod K8s',
        config: { apiServer: 'https://k8s.example.com' },
        secretRef: 'vault://openobs/k8s/prod',
        allowedNamespaces: ['default'],
      })
      .expect(201);

    expect(created.body.connector.orgId).toBe('org_a');
    expect(created.body.connector.secretRef).toBe('vault://openobs/k8s/prod');

    const listed = await request(app).get('/api/ops/connectors').expect(200);
    expect(listed.body.connectors).toHaveLength(1);
    expect(listed.body.connectors[0].id).toBe('k8s-a');
  });

  it('does not expose connectors from another org', async () => {
    await repo.create({
      id: 'k8s-b',
      orgId: 'org_b',
      name: 'Other Org',
      config: { clusterName: 'other' },
    });

    const app = makeApp(repo, 'org_a');
    const listed = await request(app).get('/api/ops/connectors').expect(200);
    expect(listed.body.connectors).toEqual([]);

    await request(app).get('/api/ops/connectors/k8s-b').expect(404);
  });

  it('deletes existing connectors and returns 404 for missing connectors', async () => {
    await repo.create({
      id: 'k8s-a',
      orgId: 'org_a',
      name: 'Prod',
      config: { clusterName: 'prod' },
    });
    const app = makeApp(repo, 'org_a');

    await request(app).delete('/api/ops/connectors/k8s-a').expect(200);
    await request(app).get('/api/ops/connectors/k8s-a').expect(404);
    await request(app).delete('/api/ops/connectors/k8s-missing').expect(404);
  });

  it('tests connector with an injected runner (no kubectl needed)', async () => {
    // The default runner now actually shells out to `kubectl version`. To
    // keep this test hermetic, we inject a stub runner that returns the
    // shape we want.
    await repo.create({
      id: 'k8s-a',
      orgId: 'org_a',
      name: 'Prod',
      config: { apiServer: 'https://k8s.example.com' },
      secret: 'fake-kubeconfig-for-structural-test',
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { auth?: Identity }).auth = {
        userId: 'u_1',
        orgId: 'org_a',
        orgRole: 'Admin',
        isServerAdmin: false,
        authenticatedBy: 'session',
      };
      next();
    });
    app.use('/api/ops/connectors', createOpsConnectorsRouter({
      connectors: repo,
      ac: makeAccessControl(),
      runner: {
        test: async () => ({
          status: 'connected' as const,
          checks: { structure: 'ok' as const, credentials: 'ok' as const, runner: 'ok' as const },
          message: 'kubectl version ok',
        }),
      },
    }));

    const tested = await request(app).post('/api/ops/connectors/k8s-a/test').expect(200);
    expect(tested.body.status).toBe('connected');
    expect(tested.body.checks.runner).toBe('ok');
  });
});
