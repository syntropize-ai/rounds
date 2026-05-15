import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Connector, Identity } from '@agentic-obs/common';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { createMetricsQueryRouter, __resetRateLimitForTests } from './metrics-query.js';

const authState = vi.hoisted(() => ({
  orgId: 'org_a',
  userId: 'user_1',
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: authState.userId,
      orgId: authState.orgId,
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  },
}));

const PROM_CONNECTOR: Connector = {
  id: 'ds_prom',
  orgId: 'org_a',
  type: 'prometheus',
  name: 'Primary Prometheus',
  config: { url: 'http://prom:9090' },
  status: 'active',
  lastVerifiedAt: null,
  lastVerifyError: null,
  isDefault: true,
  createdBy: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  capabilities: ['metrics'],
  secretMissing: false,
};

function makeSetupConfig(connectors: Connector[]) {
  return {
    getConnector: vi.fn(async (id: string) => connectors.find((c) => c.id === id) ?? null),
    listConnectors: vi.fn(async () => connectors),
  } as any;
}

function makeAc(allowed: boolean): AccessControlSurface {
  return {
    evaluate: vi.fn(async (_ident: Identity, _eval: any) => allowed),
  } as any;
}

function makeAudit() {
  return { log: vi.fn(async () => {}) } as any;
}

function makeApp(deps: Parameters<typeof createMetricsQueryRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api/metrics', createMetricsQueryRouter(deps));
  return app;
}

beforeEach(() => {
  __resetRateLimitForTests();
});

describe('POST /api/metrics/query', () => {
  it('happy path: resolves default datasource, returns series + summary', async () => {
    const buildAdapter = vi.fn(() => ({
      rangeQuery: vi.fn(async () => [
        {
          metric: { quantile: '0.95' },
          values: [
            [1700000000, '0.1'],
            [1700000060, '0.2'],
            [1700000120, '0.34'],
          ] as Array<[number, string]>,
        },
      ]),
    }));

    const audit = makeAudit();
    const app = makeApp({
      setupConfig: makeSetupConfig([PROM_CONNECTOR]),
      ac: makeAc(true),
      audit,
      buildAdapter,
    });

    const res = await request(app)
      .post('/api/metrics/query')
      .send({
        query: 'histogram_quantile(0.95, rate(http_duration_seconds_bucket[5m]))',
        timeRange: { relative: '1h' },
      });

    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(1);
    expect(res.body.summary.kind).toBe('latency');
    expect(res.body.summary.oneLine).toMatch(/peak \d+ms/);
    expect(res.body.timeRange.start).toBeTruthy();
    expect(res.body.timeRange.end).toBeTruthy();
    expect(typeof res.body.durationMs).toBe('number');
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0].action).toBe('metrics.query');
  });

  it('bad query: returns 400 BAD_QUERY when query is empty', async () => {
    const app = makeApp({
      setupConfig: makeSetupConfig([PROM_CONNECTOR]),
      ac: makeAc(true),
      audit: makeAudit(),
      buildAdapter: () => ({ rangeQuery: vi.fn() }),
    });
    const res = await request(app)
      .post('/api/metrics/query')
      .send({ query: '', timeRange: { relative: '1h' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_QUERY');
  });

  it('missing datasource: returns 400 NO_DATASOURCE when org has no Prometheus connector', async () => {
    const app = makeApp({
      setupConfig: makeSetupConfig([]),
      ac: makeAc(true),
      audit: makeAudit(),
      buildAdapter: () => ({ rangeQuery: vi.fn() }),
    });
    const res = await request(app)
      .post('/api/metrics/query')
      .send({ query: 'up', timeRange: { relative: '1h' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_DATASOURCE');
  });

  it('RBAC: returns 403 FORBIDDEN when user lacks connectors:query on the datasource', async () => {
    const app = makeApp({
      setupConfig: makeSetupConfig([PROM_CONNECTOR]),
      ac: makeAc(false),
      audit: makeAudit(),
      buildAdapter: () => ({ rangeQuery: vi.fn() }),
    });
    const res = await request(app)
      .post('/api/metrics/query')
      .send({ query: 'up', timeRange: { relative: '1h' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rate limit: returns 429 after the 31st request in the same window', async () => {
    let t = 1_700_000_000_000;
    const app = makeApp({
      setupConfig: makeSetupConfig([PROM_CONNECTOR]),
      ac: makeAc(true),
      audit: makeAudit(),
      buildAdapter: () => ({ rangeQuery: vi.fn(async () => []) }),
      now: () => t,
    });

    // 30 allowed — burn them all.
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post('/api/metrics/query')
        .send({ query: 'up', timeRange: { relative: '1h' } });
      expect(res.status).toBe(200);
    }
    const limited = await request(app)
      .post('/api/metrics/query')
      .send({ query: 'up', timeRange: { relative: '1h' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.body.error.retryAfterSec).toBeGreaterThan(0);

    // After the window rolls, requests succeed again.
    t += 61_000;
    const after = await request(app)
      .post('/api/metrics/query')
      .send({ query: 'up', timeRange: { relative: '1h' } });
    expect(after.status).toBe(200);
  });
});
