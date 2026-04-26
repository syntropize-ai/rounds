import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Evaluator, Identity, InstanceDatasource } from '@agentic-obs/common';
import { getAuthMiddleware, setAuthMiddleware } from '../../middleware/auth.js';
import { createQueryRouter } from './query.js';
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../../services/setup-config-service.js';

const baseDatasource: InstanceDatasource = {
  id: 'prom-main',
  orgId: 'org_main',
  type: 'prometheus',
  name: 'Prometheus',
  url: 'http://prom.example',
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
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
  datasources: InstanceDatasource[];
  allow?: boolean;
  seenEvaluators?: string[];
}) {
  const setupConfig = {
    getDatasource: async (id: string) => opts.datasources.find((d) => d.id === id) ?? null,
    listDatasources: async () => opts.datasources,
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

  it('requires datasources:read for labels on the resolved datasource', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      datasources: [baseDatasource],
      allow: false,
      seenEvaluators: seen,
    }))
      .get('/api/query/labels')
      .query({ datasourceId: 'prom-main' });

    expect(res.status).toBe(403);
    expect(seen).toEqual(['datasources:read on datasources:uid:prom-main']);
  });

  it('requires datasources:query for range queries on the resolved datasource', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      datasources: [baseDatasource],
      allow: false,
      seenEvaluators: seen,
    }))
      .post('/api/query/range')
      .send({ datasourceId: 'prom-main', query: 'up' });

    expect(res.status).toBe(403);
    expect(seen).toEqual(['datasources:query on datasources:uid:prom-main']);
  });

  it('does not resolve datasources owned by another org', async () => {
    const seen: string[] = [];
    const res = await request(appWith({
      datasources: [{ ...baseDatasource, orgId: 'org_other' }],
      seenEvaluators: seen,
    }))
      .post('/api/query/instant')
      .send({ datasourceId: 'prom-main', query: 'up' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_DATASOURCE');
    expect(seen).toEqual([]);
  });
});
