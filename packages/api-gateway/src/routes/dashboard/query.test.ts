import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Evaluator, Identity, Connector } from '@agentic-obs/common';
import { getAuthMiddleware, setAuthMiddleware } from '../../middleware/auth.js';
import { createQueryRouter } from './query.js';
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../../services/setup-config-service.js';

const baseConnector: Connector = {
  id: 'prom-main',
  orgId: 'org_main',
  type: 'prometheus',
  name: 'Prometheus',
  config: { url: 'http://prom.example' },
  status: 'active',
  lastVerifiedAt: null,
  lastVerifyError: null,
  isDefault: true,
  createdBy: 'user_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  capabilities: ['metrics.query'],
  secretMissing: false,
};

function identity(orgId = 'org_main'): Identity {
  return {
    userId: 'user_1',
    orgId,
    orgRole: 'Viewer',
    isServerAdmin: false,
    authenticatedBy: 'session',
  };
}

function appWith(opts: {
  connectors: Connector[];
  allow?: boolean;
  seenEvaluators?: string[];
}) {
  const setupConfig = {
    getConnector: async (id: string, lookup?: { orgId?: string }) =>
      opts.connectors.find((d) => d.id === id && d.orgId === lookup?.orgId) ?? null,
    listConnectors: async (lookup?: { orgId?: string }) =>
      opts.connectors.filter((d) => d.orgId === lookup?.orgId),
  } as unknown as SetupConfigService;
  const accessControl: AccessControlSurface = {
    getUserPermissions: async () => [],
    ensurePermissions: async () => [],
    filterByPermission: async (_identity, items) => [...items],
    evaluate: async (_identity: Identity, evaluator: Evaluator) => {
      opts.seenEvaluators?.push(evaluator.string());
      return opts.allow ?? true;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/query', createQueryRouter({ setupConfig, ac: accessControl }));
  return app;
}

describe('query proxy permissions', () => {
  const originalAuthMiddleware = getAuthMiddleware();

  beforeEach(() => {
    setAuthMiddleware((req, _res, next) => {
      req.auth = identity();
      next();
    });
  });

  afterEach(() => {
    setAuthMiddleware(originalAuthMiddleware);
    vi.unstubAllGlobals();
  });

  it('requires connectors:read for labels on the resolved datasource', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      connectors: [baseConnector],
      allow: false,
      seenEvaluators: seen,
    }))
      .get('/api/query/labels')
      .query({ datasourceId: 'prom-main' });

    expect(res.status).toBe(403);
    expect(seen).toEqual(['connectors:read on connectors:uid:prom-main']);
  });

  it('requires connectors:query for range queries on the resolved datasource', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      connectors: [baseConnector],
      allow: false,
      seenEvaluators: seen,
    }))
      .post('/api/query/range')
      .send({ datasourceId: 'prom-main', query: 'up' });

    expect(res.status).toBe(403);
    expect(seen).toEqual(['connectors:query on connectors:uid:prom-main']);
  });

  it('does not resolve connectors owned by another org', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      connectors: [{ ...baseConnector, orgId: 'org_other' }],
      seenEvaluators: seen,
    }))
      .post('/api/query/instant')
      .send({ datasourceId: 'prom-main', query: 'up' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_DATASOURCE');
    expect(seen).toEqual([]);
  });

  it('substitutes ${datasource} placeholders against variableValues before resolving', async () => {
    const seen: string[] = [];
    const prodDs: Connector = { ...baseConnector, id: 'prom-prod', name: 'prod' };
    const stagingDs: Connector = { ...baseConnector, id: 'prom-staging', name: 'staging', isDefault: false };
    // Stub fetch so the route's actual Prometheus call is intercepted — the
    // assertion is on which datasource was resolved, not on a real backend.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const res = await request(appWith({
      connectors: [prodDs, stagingDs],
      seenEvaluators: seen,
    }))
      .post('/api/query/instant')
      .send({
        datasourceId: '${datasource}',
        query: 'up',
        variableValues: { datasource: 'prom-prod' },
      });

    // The placeholder resolved to prom-prod, so the gate evaluated against
    // that scope and the route attempted a fetch against the prod base url.
    expect(seen).toContain('connectors:query on connectors:uid:prom-prod');
    expect(res.status).toBe(200);
    const fetchedUrl = (fetchSpy.mock.calls[0]?.[0] as string | URL | undefined)?.toString() ?? '';
    expect(fetchedUrl).toContain('prom.example');
  });

  it('does not treat connectors without org ownership as shared', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      connectors: [{ ...baseConnector, orgId: undefined as unknown as string }],
      seenEvaluators: seen,
    }))
      .post('/api/query/instant')
      .send({ datasourceId: 'prom-main', query: 'up' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_DATASOURCE');
    expect(seen).toEqual([]);
  });
});
