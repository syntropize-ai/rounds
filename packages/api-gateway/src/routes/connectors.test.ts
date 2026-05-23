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
  ConnectorTeamPolicy,
  ConnectorType,
  Evaluator,
  Identity,
  NewConnector,
  ResolvedPermission,
  UpsertConnectorTeamPolicy,
} from '@agentic-obs/common';
import type {
  ConnectorListFilter,
  ConnectorRepository,
  ConnectorPolicy,
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
  policies: ConnectorTeamPolicy[] = [];

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
  async listPolicies(opts: { connectorId: string }): Promise<ConnectorPolicy[]> {
    return this.policies.filter((p) => p.connectorId === opts.connectorId);
  }
  async upsertPolicy(policy: UpsertConnectorTeamPolicy): Promise<ConnectorPolicy> {
    const teamId = policy.teamId ?? '';
    const row: ConnectorTeamPolicy = {
      connectorId: policy.connectorId,
      teamId,
      capability: policy.capability,
      scope: policy.scope ?? null,
      humanPolicy: policy.humanPolicy,
      agentPolicy: policy.agentPolicy,
    };
    const idx = this.policies.findIndex(
      (p) =>
        p.connectorId === row.connectorId &&
        p.teamId === row.teamId &&
        p.capability === row.capability,
    );
    if (idx >= 0) this.policies[idx] = row;
    else this.policies.push(row);
    return row;
  }
  async deletePolicy(connectorId: string, teamId: string, capability: string): Promise<boolean> {
    const before = this.policies.length;
    this.policies = this.policies.filter(
      (p) => !(p.connectorId === connectorId && p.teamId === teamId && p.capability === capability),
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
    // All seeds use teamId === '' (wildcard).
    expect(seeded.every((p) => p.teamId === '')).toBe(true);
    // Spot-check key invariants from the seed table.
    const byCap = new Map(seeded.map((p) => [p.capability, p] as const));
    expect(byCap.get('runtime.get')?.agentPolicy).toBe('allow');
    expect(byCap.get('runtime.apply')?.agentPolicy).toBe('formal_approval');
    expect(byCap.get('runtime.delete')?.humanPolicy).toBe('strong_confirm');
    expect(byCap.get('runtime.exec')?.agentPolicy).toBe('deny');
    expect(byCap.get('runtime.port_forward')?.agentPolicy).toBe('deny');
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
  it('never grants agent=allow to a write verb', () => {
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
        expect(p.agentPolicy).not.toBe('allow');
      }
    }
  });
});
