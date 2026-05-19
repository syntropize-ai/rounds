/**
 * pending-changes router — request-level integration tests.
 *
 * Uses a permissive accessControl stub so the focus is on the route logic
 * (filter, accept-apply, reject, count). Permission denial is exercised by
 * flipping the stub to deny.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Dashboard, PanelConfig } from '@agentic-obs/common';
import type {
  IPendingChangeRepository,
  IGatewayDashboardStore,
  PendingChange,
} from '@agentic-obs/data-layer';
import { createPendingChangesRouter } from './pending-changes.js';
import { setAuthMiddleware } from '../middleware/auth.js';

// The router calls `router.use(authMiddleware)`; the singleton is normally
// bound in app boot. For unit tests we install a passthrough so the inline
// authMW in `makeApp` is the only thing populating `req.auth`.
beforeAll(() => {
  setAuthMiddleware(((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()) as never);
});
afterAll(() => {
  setAuthMiddleware(null);
});

function authMW(opts: { orgId?: string; userId?: string } = {}) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { auth: unknown }).auth = {
      userId: opts.userId ?? 'user_1',
      orgId: opts.orgId ?? 'org_main',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
      permissions: undefined,
    };
    next();
  };
}

function makeApp(deps: {
  repo: IPendingChangeRepository;
  dashboards: IGatewayDashboardStore;
  allow?: boolean;
}) {
  const app = express();
  app.use(express.json());
  app.use(authMW());
  const router = createPendingChangesRouter({
    pendingChanges: deps.repo,
    dashboards: deps.dashboards,
    accessControl: {
      evaluate: vi.fn(async () => deps.allow ?? true),
    } as unknown as Parameters<typeof createPendingChangesRouter>[0]['accessControl'],
  });
  app.use('/api', router);
  return app;
}

function mockPending(overrides: Partial<PendingChange> = {}): PendingChange {
  return {
    id: overrides.id ?? 'pc-1',
    orgId: overrides.orgId ?? 'org_main',
    dashboardId: overrides.dashboardId ?? 'd-1',
    panelId: overrides.panelId === undefined ? 'p-1' : overrides.panelId,
    proposedBy: overrides.proposedBy ?? 'agent:sess-1',
    proposedAt: overrides.proposedAt ?? new Date().toISOString(),
    status: overrides.status ?? 'pending',
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
    changeKind: overrides.changeKind ?? 'modify_panel',
    beforeJson: overrides.beforeJson === undefined ? { id: 'p-1', title: 'old' } : overrides.beforeJson,
    afterJson: overrides.afterJson ?? { id: 'p-1', title: 'new' },
    summary: overrides.summary ?? 'Rename panel',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function mockDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: overrides.id ?? 'd-1',
    type: 'dashboard',
    title: overrides.title ?? 'Dash',
    description: overrides.description ?? '',
    prompt: '',
    userId: 'agent',
    status: 'ready',
    panels: overrides.panels ?? [{ id: 'p-1', title: 'old', visualization: 'time_series', queries: [], row: 0, col: 0, width: 6, height: 3 } as unknown as PanelConfig],
    variables: overrides.variables ?? [],
    workspaceId: 'org_main',
    refreshIntervalSec: 0,
    folder: null,
    datasourceIds: [],
  } as unknown as Dashboard;
}

describe('pending-changes router', () => {
  it('GET /api/dashboards/:id/pending-changes returns rows', async () => {
    const row = mockPending();
    const repo = {
      listByDashboard: vi.fn(async () => [row]),
    } as unknown as IPendingChangeRepository;
    const app = makeApp({
      repo,
      dashboards: { findById: vi.fn() } as unknown as IGatewayDashboardStore,
    });
    const res = await request(app).get('/api/dashboards/d-1/pending-changes');
    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].id).toBe('pc-1');
  });

  it('GET list 403s when permission denied', async () => {
    const repo = {
      listByDashboard: vi.fn(async () => []),
    } as unknown as IPendingChangeRepository;
    const app = makeApp({
      repo,
      dashboards: { findById: vi.fn() } as unknown as IGatewayDashboardStore,
      allow: false,
    });
    const res = await request(app).get('/api/dashboards/d-1/pending-changes');
    expect(res.status).toBe(403);
  });

  it('GET /api/pending-changes/count aggregates only visible dashboards', async () => {
    const repo = {
      countByOrgGrouped: vi.fn(async () => [
        { dashboardId: 'd-1', count: 2 },
        { dashboardId: 'd-2', count: 1 },
      ]),
      listByDashboard: vi.fn(async (_orgId: string, dashboardId: string) => {
        if (dashboardId === 'd-1') {
          return [
            mockPending({ id: 'pc-1', dashboardId: 'd-1', panelId: 'p-1', summary: 'tweak A', changeKind: 'modify_panel' }),
            mockPending({ id: 'pc-2', dashboardId: 'd-1', panelId: 'p-2', summary: 'tweak B', changeKind: 'modify_panel' }),
          ];
        }
        if (dashboardId === 'd-2') {
          return [mockPending({ id: 'pc-3', dashboardId: 'd-2', panelId: null, summary: 'rename', changeKind: 'set_title' })];
        }
        return [];
      }),
    } as unknown as IPendingChangeRepository;
    const dashboards = {
      findById: vi.fn(async (id: string) =>
        id === 'd-1' ? mockDashboard({ id: 'd-1' }) : id === 'd-2' ? mockDashboard({ id: 'd-2', title: 'Other' }) : undefined,
      ),
    } as unknown as IGatewayDashboardStore;
    const app = makeApp({ repo, dashboards });
    const res = await request(app).get('/api/pending-changes/count');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.byDashboard).toHaveLength(2);
    expect(res.body.byDashboard[0].dashboardTitle).toBeDefined();
    expect(res.body.byDashboard[0].changes).toHaveLength(2);
  });

  it('POST accept applies modify_panel and marks row accepted', async () => {
    const row = mockPending({ changeKind: 'modify_panel', afterJson: { id: 'p-1', title: 'new' } });
    const dash = mockDashboard();
    const repo = {
      getById: vi.fn(async () => row),
      resolve: vi.fn(async () => ({ ...row, status: 'accepted', resolvedBy: 'user_1' })),
    } as unknown as IPendingChangeRepository;
    const updatePanels = vi.fn(async (_id: string, panels: PanelConfig[]) => ({
      ...dash,
      panels,
    }));
    const dashboards = {
      findById: vi.fn(async () => dash),
      updatePanels,
    } as unknown as IGatewayDashboardStore;
    const app = makeApp({ repo, dashboards });
    const res = await request(app).post('/api/dashboards/d-1/pending-changes/pc-1/accept').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(updatePanels).toHaveBeenCalledWith('d-1', [
      expect.objectContaining({ id: 'p-1', title: 'new' }),
    ]);
    expect(repo.resolve).toHaveBeenCalledWith('org_main', 'pc-1', 'accepted', 'user_1');
  });

  it('POST accept 404s for unknown change id', async () => {
    const repo = {
      getById: vi.fn(async () => null),
    } as unknown as IPendingChangeRepository;
    const app = makeApp({
      repo,
      dashboards: { findById: vi.fn() } as unknown as IGatewayDashboardStore,
    });
    const res = await request(app).post('/api/dashboards/d-1/pending-changes/missing/accept').send({});
    expect(res.status).toBe(404);
  });

  it('POST accept 409s for already-resolved change', async () => {
    const row = mockPending({ status: 'accepted' });
    const repo = {
      getById: vi.fn(async () => row),
    } as unknown as IPendingChangeRepository;
    const app = makeApp({
      repo,
      dashboards: { findById: vi.fn() } as unknown as IGatewayDashboardStore,
    });
    const res = await request(app).post('/api/dashboards/d-1/pending-changes/pc-1/accept').send({});
    expect(res.status).toBe(409);
  });

  it('POST reject marks row rejected without touching dashboard', async () => {
    const row = mockPending();
    const repo = {
      getById: vi.fn(async () => row),
      resolve: vi.fn(async () => ({ ...row, status: 'rejected', resolvedBy: 'user_1' })),
    } as unknown as IPendingChangeRepository;
    const dashboards = {
      findById: vi.fn(),
      updatePanels: vi.fn(),
    } as unknown as IGatewayDashboardStore;
    const app = makeApp({ repo, dashboards });
    const res = await request(app).post('/api/dashboards/d-1/pending-changes/pc-1/reject').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dashboards.updatePanels).not.toHaveBeenCalled();
    expect(repo.resolve).toHaveBeenCalledWith('org_main', 'pc-1', 'rejected', 'user_1');
  });

  it('accept-all returns per-id results', async () => {
    const a = mockPending({ id: 'a' });
    const b = mockPending({ id: 'b', status: 'accepted' }); // already-resolved
    const repo = {
      getById: vi.fn(async (_org: string, id: string) => (id === 'a' ? a : id === 'b' ? b : null)),
      resolve: vi.fn(async () => ({ ...a, status: 'accepted' })),
    } as unknown as IPendingChangeRepository;
    const dashboards = {
      findById: vi.fn(async () => mockDashboard()),
      updatePanels: vi.fn(async () => mockDashboard()),
    } as unknown as IGatewayDashboardStore;
    const app = makeApp({ repo, dashboards });
    const res = await request(app)
      .post('/api/dashboards/d-1/pending-changes/accept-all')
      .send({ ids: ['a', 'b', 'missing'] });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.results.map((r: { id: string }) => [r.id, r]));
    expect(byId['a'].ok).toBe(true);
    expect(byId['b'].ok).toBe(false);
    expect(byId['b'].reason).toBe('accepted');
    expect(byId['missing'].ok).toBe(false);
    expect(byId['missing'].reason).toBe('not_found');
  });
});
