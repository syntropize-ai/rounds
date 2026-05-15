/**
 * Tests for the inline-chart save-as-dashboard endpoints:
 *   - /preview  → similarity matches
 *   - /save     → creates new or appends panel
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Dashboard, PanelConfig, Identity } from '@agentic-obs/common';
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import {
  createMetricsSaveAsDashboardRouter,
  normalizePromQL,
  querySimilarity,
} from './metrics-save-as-dashboard.js';

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: 'user_1',
      orgId: 'org_main',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  },
}));

function panel(overrides: Partial<PanelConfig> = {}): PanelConfig {
  return {
    id: 'p1',
    title: 'Latency',
    description: '',
    visualization: 'time_series',
    row: 0,
    col: 0,
    width: 6,
    height: 4,
    ...overrides,
  };
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash_a',
    type: 'dashboard',
    title: 'HTTP Service Health',
    description: '',
    prompt: '',
    userId: 'user_1',
    status: 'ready',
    panels: [],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: ['ds_prom'],
    useExistingMetrics: true,
    workspaceId: 'org_main',
    source: 'manual',
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  };
}

function makeStore(dashboards: Dashboard[]): IGatewayDashboardStore {
  const map = new Map(dashboards.map((d) => [d.id, { ...d }] as const));
  return {
    create: vi.fn(async (input: Parameters<IGatewayDashboardStore['create']>[0]) => {
      const d = dashboard({
        id: 'dash_new',
        title: input.title,
        prompt: input.prompt,
        datasourceIds: input.datasourceIds ?? [],
        userId: input.userId,
        workspaceId: input.workspaceId ?? 'org_main',
        panels: [],
      });
      map.set(d.id, d);
      return d;
    }),
    findById: vi.fn(async (id: string) => map.get(id)),
    findAll: vi.fn(async () => Array.from(map.values())),
    listByWorkspace: vi.fn(async () => Array.from(map.values())),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updatePanels: vi.fn(async (id: string, panels: PanelConfig[]) => {
      const d = map.get(id);
      if (!d) return undefined;
      const updated = { ...d, panels };
      map.set(id, updated);
      return updated;
    }),
    updateVariables: vi.fn(),
    delete: vi.fn(),
    getFolderUid: vi.fn(async () => null),
  } as unknown as IGatewayDashboardStore;
}

function makeAc(allowed: boolean): AccessControlSurface {
  return {
    evaluate: vi.fn(async (_id: Identity, _e: any) => allowed),
  } as unknown as AccessControlSurface;
}

function makeAudit() {
  return { log: vi.fn(async () => {}) } as any;
}

function makeApp(store: IGatewayDashboardStore, allowed = true) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/metrics',
    createMetricsSaveAsDashboardRouter({
      dashboardStore: store,
      ac: makeAc(allowed),
      audit: makeAudit(),
    }),
  );
  return app;
}

describe('normalizePromQL + querySimilarity', () => {
  it('sorts label selectors and lowercases', () => {
    expect(normalizePromQL('Up{job="api", env="prod"}')).toBe('up{env="prod",job="api"}');
  });
  it('high similarity for nearly-identical queries', () => {
    const a = 'sum(rate(http_requests_total{job="api"}[5m]))';
    const b = 'sum(rate(http_requests_total{job="api"}[1m]))';
    expect(querySimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });
  it('low similarity for unrelated queries', () => {
    expect(querySimilarity('node_memory_used_bytes', 'rate(http_5xx_total[1m])')).toBeLessThan(0.6);
  });
});

describe('POST /api/metrics/save-as-dashboard/preview', () => {
  it('returns matches above the 60% threshold sorted by similarity', async () => {
    const matching = dashboard({
      id: 'dash_match',
      title: 'HTTP Service Health',
      panels: [panel({ queries: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))' }] })],
    });
    const unrelated = dashboard({
      id: 'dash_other',
      title: 'Memory',
      panels: [panel({ queries: [{ refId: 'A', expr: 'node_memory_used_bytes' }] })],
    });
    const store = makeStore([matching, unrelated]);
    const res = await request(makeApp(store))
      .post('/api/metrics/save-as-dashboard/preview')
      .send({ query: 'sum(rate(http_requests_total[1m]))' });
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].dashboardId).toBe('dash_match');
    expect(res.body.matches[0].similarityPct).toBeGreaterThanOrEqual(60);
  });

  it('returns empty matches when nothing is similar', async () => {
    const store = makeStore([
      dashboard({ panels: [panel({ queries: [{ refId: 'A', expr: 'node_memory_used_bytes' }] })] }),
    ]);
    const res = await request(makeApp(store))
      .post('/api/metrics/save-as-dashboard/preview')
      .send({ query: 'histogram_quantile(0.95, rate(http_duration_bucket[5m]))' });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });
});

describe('POST /api/metrics/save-as-dashboard', () => {
  it('creates a new dashboard with one panel when no existing id is given', async () => {
    const store = makeStore([]);
    const res = await request(makeApp(store))
      .post('/api/metrics/save-as-dashboard')
      .send({
        title: 'p50 latency (2026-05-13)',
        query: 'histogram_quantile(0.5, sum(rate(http_duration_bucket[5m])) by (le))',
        metricKind: 'latency',
        datasourceId: 'ds_prom',
      });
    expect(res.status).toBe(201);
    expect(res.body.dashboardId).toBe('dash_new');
    expect(res.body.url).toBe('/dashboards/dash_new');
    expect(store.create).toHaveBeenCalledOnce();
    expect(store.updatePanels).toHaveBeenCalledOnce();
  });

  it('appends a panel to an existing dashboard when addToExistingDashboardId is set', async () => {
    const existing = dashboard({
      id: 'dash_existing',
      panels: [panel({ id: 'p_old', row: 0, height: 4 })],
    });
    const store = makeStore([existing]);
    const res = await request(makeApp(store))
      .post('/api/metrics/save-as-dashboard')
      .send({
        title: 'New panel',
        query: 'rate(http_requests_total[1m])',
        metricKind: 'counter',
        datasourceId: 'ds_prom',
        addToExistingDashboardId: 'dash_existing',
      });
    expect(res.status).toBe(200);
    expect(res.body.dashboardId).toBe('dash_existing');
    const call = vi.mocked(store.updatePanels).mock.calls[0]!;
    expect(call[0]).toBe('dash_existing');
    expect(call[1]).toHaveLength(2);
    // New panel placed after the old one (row 4).
    expect(call[1][1]!.row).toBe(4);
  });

  it('rejects with 403 when access control denies', async () => {
    const store = makeStore([]);
    const res = await request(makeApp(store, /*allowed=*/ false))
      .post('/api/metrics/save-as-dashboard')
      .send({
        title: 't',
        query: 'up',
        metricKind: 'gauge',
        datasourceId: 'ds_prom',
      });
    expect(res.status).toBe(403);
  });

  it('rejects with 400 when required fields are missing', async () => {
    const store = makeStore([]);
    const res = await request(makeApp(store))
      .post('/api/metrics/save-as-dashboard')
      .send({ title: '', query: '', metricKind: 'gauge', datasourceId: '' });
    expect(res.status).toBe(400);
  });
});
