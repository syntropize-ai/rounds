/**
 * /api/connectors route — coverage for the kubernetes default-policy seed
 * (creating a kubernetes connector should upsert one wildcard policy row per
 * verb in KUBERNETES_DEFAULT_POLICIES).
 */

import { describe, it, expect } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import type {
  Connector,
  ConnectorPatch,
  ConnectorPolicy,
  ConnectorSubjectType,
  ConnectorType,
  Evaluator,
  Identity,
  NewConnector,
  ResolvedPermission,
  UpsertConnectorPolicy,
} from '@agentic-obs/common';
import type {
  ConnectorListFilter,
  ConnectorRepository,
} from '../services/connector-service.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import {
  createConnectorsRouter,
  KUBERNETES_DEFAULT_POLICIES,
} from './connectors.js';

function makeConnector(input: NewConnector): Connector {
  return {
    id: input.id ?? 'cx',
    orgId: input.orgId,
    type: input.type,
    name: input.name,
    config: input.config ?? {},
    status: 'draft',
    lastVerifiedAt: null,
    lastVerifyError: null,
    isDefault: input.isDefault ?? false,
    createdBy: input.createdBy,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    capabilities: [],
    secretMissing: true,
  };
}

class MemoryConnectorRepo implements ConnectorRepository {
  connectors = new Map<string, Connector>();
  policies: ConnectorPolicy[] = [];

  async list(filter: ConnectorListFilter): Promise<Connector[]> {
    return [...this.connectors.values()].filter((c) => c.orgId === filter.orgId);
  }
  async get(id: string, opts: { orgId: string }): Promise<Connector | null> {
    const row = this.connectors.get(id);
    return row && row.orgId === opts.orgId ? row : null;
  }
  async create(input: NewConnector): Promise<Connector> {
    const row = makeConnector(input);
    this.connectors.set(row.id, row);
    return row;
  }
  async update(id: string, patch: ConnectorPatch, orgId: string): Promise<Connector | null> {
    const row = this.connectors.get(id);
    if (!row || row.orgId !== orgId) return null;
    const next = { ...row, ...patch, updatedAt: '2026-01-01T00:00:01Z' };
    this.connectors.set(id, next);
    return next;
  }
  async delete(id: string, orgId: string): Promise<boolean> {
    const row = this.connectors.get(id);
    if (!row || row.orgId !== orgId) return false;
    this.connectors.delete(id);
    return true;
  }
  async listPolicies(opts: {
    connectorId: string;
    subjectType?: ConnectorSubjectType;
    subjectId?: string;
  }): Promise<ConnectorPolicy[]> {
    return this.policies.filter(
      (p) =>
        p.connectorId === opts.connectorId &&
        (opts.subjectType === undefined || p.subjectType === opts.subjectType) &&
        (opts.subjectId === undefined || p.subjectId === opts.subjectId),
    );
  }
  async upsertPolicy(policy: UpsertConnectorPolicy): Promise<ConnectorPolicy> {
    const row: ConnectorPolicy = {
      connectorId: policy.connectorId,
      subjectType: policy.subjectType,
      subjectId: policy.subjectId,
      capability: policy.capability,
      scope: policy.scope ?? null,
      humanPolicy: policy.humanPolicy,
    };
    const idx = this.policies.findIndex(
      (p) =>
        p.connectorId === row.connectorId &&
        p.subjectType === row.subjectType &&
        p.subjectId === row.subjectId &&
        p.capability === row.capability,
    );
    if (idx >= 0) this.policies[idx] = row;
    else this.policies.push(row);
    return row;
  }
  async deletePolicy(
    connectorId: string,
    subjectType: ConnectorSubjectType,
    subjectId: string,
    capability: string,
  ): Promise<boolean> {
    const before = this.policies.length;
    this.policies = this.policies.filter(
      (p) =>
        !(
          p.connectorId === connectorId &&
          p.subjectType === subjectType &&
          p.subjectId === subjectId &&
          p.capability === capability
        ),
    );
    return this.policies.length < before;
  }
}

function permissiveAc(): AccessControlSurface {
  return {
    async getUserPermissions(_identity: Identity): Promise<ResolvedPermission[]> {
      return [];
    },
    async evaluate(_identity: Identity, _evaluator: Evaluator): Promise<boolean> {
      return true;
    },
    async ensurePermissions(_identity: Identity): Promise<ResolvedPermission[]> {
      return [];
    },
    async filterByPermission<T>(
      _identity: Identity,
      items: readonly T[],
      _buildEvaluator: (item: T) => Evaluator,
    ): Promise<T[]> {
      return [...items];
    },
  };
}

function mountRouter(repo: ConnectorRepository): express.Express {
  const app = express();
  app.use(express.json());
  // Inject an authenticated identity into req.auth so the router sees an org.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { auth: Identity }).auth = {
      userId: 'u1',
      orgId: 'org_a',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  });
  app.use(
    '/api/connectors',
    createConnectorsRouter({ connectors: repo, ac: permissiveAc() }),
  );
  return app;
}

describe('POST /api/connectors — kubernetes default policy seed', () => {
  it('seeds wildcard policy rows for kubernetes connectors', async () => {
    const repo = new MemoryConnectorRepo();
    const app = mountRouter(repo);

    const res = await request(app)
      .post('/api/connectors')
      .send({
        id: 'kube-prod',
        type: 'kubernetes' as ConnectorType,
        name: 'Prod K8s',
        config: { apiServer: 'https://k8s.example.com' },
      });
    expect(res.status).toBe(201);

    const seeded = repo.policies.filter((p) => p.connectorId === 'kube-prod');
    expect(seeded.length).toBe(KUBERNETES_DEFAULT_POLICIES.length);
    // All seeds use subjectType='org' keyed by the connector's orgId.
    expect(seeded.every((p) => p.subjectType === 'org' && p.subjectId === 'org_a')).toBe(true);
    // Spot-check key invariants from the seed table.
    const byCap = new Map(seeded.map((p) => [p.capability, p] as const));
    expect(byCap.get('runtime.get')?.humanPolicy).toBe('allow');
    expect(byCap.get('runtime.apply')?.humanPolicy).toBe('ask');
    expect(byCap.get('runtime.delete')?.humanPolicy).toBe('ask');
    expect(byCap.get('runtime.exec')?.humanPolicy).toBe('ask');
    expect(byCap.get('runtime.port_forward')?.humanPolicy).toBe('ask');
  });

  it('does NOT seed for non-kubernetes connector types', async () => {
    const repo = new MemoryConnectorRepo();
    const app = mountRouter(repo);

    const res = await request(app)
      .post('/api/connectors')
      .send({
        id: 'prom1',
        type: 'prometheus' as ConnectorType,
        name: 'Prom',
        config: { url: 'http://prom:9090' },
      });
    expect(res.status).toBe(201);
    expect(repo.policies.filter((p) => p.connectorId === 'prom1')).toHaveLength(0);
  });
});

describe('KUBERNETES_DEFAULT_POLICIES table invariants', () => {
  it('covers the curated capability set without duplicates', () => {
    const caps = KUBERNETES_DEFAULT_POLICIES.map((p) => p.capability);
    expect(new Set(caps).size).toBe(caps.length);
    expect(caps).toContain('runtime.exec');
    expect(caps).toContain('runtime.apply');
  });
  it('never auto-allows a write verb (humanPolicy != allow)', () => {
    const writeVerbs = new Set([
      'runtime.create',
      'runtime.apply',
      'runtime.patch',
      'runtime.delete',
      'runtime.scale',
      'runtime.restart',
      'runtime.rollout',
      'runtime.exec',
      'runtime.port_forward',
      'runtime.drain',
    ]);
    for (const p of KUBERNETES_DEFAULT_POLICIES) {
      if (writeVerbs.has(p.capability)) {
        expect(p.humanPolicy).not.toBe('allow');
      }
    }
  });
});

async function seedConnector(repo: MemoryConnectorRepo, id = 'cx'): Promise<void> {
  await repo.create({
    id,
    orgId: 'org_a',
    type: 'prometheus' as ConnectorType,
    name: 'p',
    config: {},
    createdBy: 'u1',
  });
}

describe('PUT /api/connectors/:id/policies — validation', () => {
  const validBody = {
    subjectType: 'org',
    subjectId: 'org_a',
    capability: 'metrics.query',
    humanPolicy: 'allow',
  } as const;

  async function putBody(body: unknown): Promise<{ status: number; body: unknown }> {
    const repo = new MemoryConnectorRepo();
    await seedConnector(repo);
    const app = mountRouter(repo);
    const res = await request(app).put('/api/connectors/cx/policies').send(body as object);
    return { status: res.status, body: res.body };
  }

  it('rejects missing subjectType', async () => {
    const { status, body } = await putBody({ ...validBody, subjectType: undefined });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('VALIDATION');
  });

  it.each([['user'], [''], ['TEAM']])('rejects subjectType=%s', async (bad) => {
    const { status } = await putBody({ ...validBody, subjectType: bad });
    expect(status).toBe(400);
  });

  it('rejects missing subjectId', async () => {
    const { status } = await putBody({ ...validBody, subjectId: undefined });
    expect(status).toBe(400);
  });

  it('rejects empty subjectId', async () => {
    const { status } = await putBody({ ...validBody, subjectId: '' });
    expect(status).toBe(400);
  });

  it('rejects missing capability', async () => {
    const { status } = await putBody({ ...validBody, capability: undefined });
    expect(status).toBe(400);
  });

  it('rejects missing humanPolicy', async () => {
    const { status } = await putBody({ ...validBody, humanPolicy: undefined });
    expect(status).toBe(400);
  });

  it.each([['confirm'], ['deny']])('rejects legacy humanPolicy=%s', async (bad) => {
    const { status } = await putBody({ ...validBody, humanPolicy: bad });
    expect(status).toBe(400);
  });
});

describe('DELETE /api/connectors/:id/policies/:subjectType/:subjectId/:capability', () => {
  it('returns 400 for bad subjectType in path', async () => {
    const repo = new MemoryConnectorRepo();
    await seedConnector(repo);
    const app = mountRouter(repo);
    const res = await request(app).delete('/api/connectors/cx/policies/user/team-a/metrics.query');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('handles a capability containing a dot (express does not split path on .)', async () => {
    const repo = new MemoryConnectorRepo();
    await seedConnector(repo);
    // pre-insert a dotted-capability policy
    await repo.upsertPolicy({
      connectorId: 'cx',
      subjectType: 'team',
      subjectId: 'team-a',
      capability: 'metrics.query',
      scope: null,
      humanPolicy: 'allow',
    });
    const app = mountRouter(repo);
    const res = await request(app).delete('/api/connectors/cx/policies/team/team-a/metrics.query');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(repo.policies).toHaveLength(0);
  });

  it('returns 404 when the policy row does not exist', async () => {
    const repo = new MemoryConnectorRepo();
    await seedConnector(repo);
    const app = mountRouter(repo);
    const res = await request(app).delete('/api/connectors/cx/policies/team/team-z/metrics.query');
    expect(res.status).toBe(404);
  });
});

describe('maskForWire — credential redaction', () => {
  it('strips credential-shaped keys from config in GET /:id', async () => {
    const repo = new MemoryConnectorRepo();
    await repo.create({
      id: 'leaky',
      orgId: 'org_a',
      type: 'prometheus' as ConnectorType,
      name: 'p',
      config: {
        url: 'http://prom:9090',
        apiKey: 'sk-leak-me',
        password: 'hunter2',
        bearerToken: 'eyJ-leak',
        client_secret: 'shhh',
        privateKey: '-----BEGIN-----',
        tlsVerify: true,
      },
      createdBy: 'u1',
    });
    const app = mountRouter(repo);
    const res = await request(app).get('/api/connectors/leaky');
    expect(res.status).toBe(200);
    const cfg = res.body.connector.config as Record<string, unknown>;
    expect(cfg).toEqual({ url: 'http://prom:9090', tlsVerify: true });
    expect(JSON.stringify(res.body)).not.toContain('sk-leak-me');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('eyJ-leak');
  });

  it('strips credential-shaped keys from config in GET / list', async () => {
    const repo = new MemoryConnectorRepo();
    await repo.create({
      id: 'leaky2',
      orgId: 'org_a',
      type: 'prometheus' as ConnectorType,
      name: 'p',
      config: { url: 'http://prom:9090', apiKey: 'sk-leak-me' },
      createdBy: 'u1',
    });
    const app = mountRouter(repo);
    const res = await request(app).get('/api/connectors');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('sk-leak-me');
  });
});

describe('GET /api/connectors/:id/policies — query filter', () => {
  async function setupWithMixedPolicies(): Promise<MemoryConnectorRepo> {
    const repo = new MemoryConnectorRepo();
    await seedConnector(repo);
    await repo.upsertPolicy({
      connectorId: 'cx',
      subjectType: 'org',
      subjectId: 'org_a',
      capability: 'metrics.query',
      scope: null,
      humanPolicy: 'allow',
    });
    await repo.upsertPolicy({
      connectorId: 'cx',
      subjectType: 'team',
      subjectId: 'team-a',
      capability: 'metrics.query',
      scope: null,
      humanPolicy: 'ask',
    });
    await repo.upsertPolicy({
      connectorId: 'cx',
      subjectType: 'team',
      subjectId: 'team-b',
      capability: 'metrics.query',
      scope: null,
      humanPolicy: 'block',
    });
    return repo;
  }

  it('returns all policies when no filter is given', async () => {
    const repo = await setupWithMixedPolicies();
    const app = mountRouter(repo);
    const res = await request(app).get('/api/connectors/cx/policies');
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(3);
  });

  it('filters by subjectType=org', async () => {
    const repo = await setupWithMixedPolicies();
    const app = mountRouter(repo);
    const res = await request(app).get('/api/connectors/cx/policies?subjectType=org');
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(1);
    expect(res.body.policies[0].subjectType).toBe('org');
  });

  it('filters by subjectType=team & subjectId=team-a', async () => {
    const repo = await setupWithMixedPolicies();
    const app = mountRouter(repo);
    const res = await request(app).get('/api/connectors/cx/policies?subjectType=team&subjectId=team-a');
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(1);
    expect(res.body.policies[0].subjectId).toBe('team-a');
  });

  it('returns 400 for an invalid subjectType query value', async () => {
    const repo = await setupWithMixedPolicies();
    const app = mountRouter(repo);
    const res = await request(app).get('/api/connectors/cx/policies?subjectType=user');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
