/**
 * Route-level coverage for the panel-event recording side effect. Verifies
 * that each dashboard CRUD endpoint that should emit a panel_events row
 * actually calls the repo, with the right event_type and payload.
 *
 * Tests use a small in-memory IPanelEventRepository so we can assert
 * exactly which rows the route would insert without spinning up SQLite.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Dashboard, PanelConfig } from '@agentic-obs/common';
import type {
  IGatewayDashboardStore,
  IPanelEventRepository,
  PanelEvent,
} from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../../services/setup-config-service.js';
import { createDashboardRouter } from './router.js';

vi.mock('../../middleware/auth.js', () => ({
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
    id: 'panel_1',
    title: 'Latency',
    description: '',
    visualization: 'time_series',
    queries: [{ refId: 'A', expr: 'sum(rate(http_requests_total{app="foo"}[5m]))' }],
    row: 0,
    col: 0,
    width: 6,
    height: 4,
    ...overrides,
  };
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash_1',
    type: 'dashboard',
    title: 'Owned',
    description: '',
    prompt: 'show me latency',
    userId: 'user_1',
    status: 'ready',
    panels: [panel()],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    workspaceId: 'org_main',
    source: 'manual',
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  };
}

class FakePanelEventRepo implements IPanelEventRepository {
  records: Array<Omit<PanelEvent, 'id' | 'createdAt'>> = [];
  async record(input: Omit<PanelEvent, 'id' | 'createdAt'>): Promise<{ id: string }> {
    this.records.push(input);
    return { id: `evt_${this.records.length}` };
  }
  async findByDashboard(): Promise<PanelEvent[]> {
    return [];
  }
  async findByQuerySignature(): Promise<PanelEvent[]> {
    return [];
  }
  async aggregateBySignature(): Promise<never[]> {
    return [];
  }
}

function makeStore(dash: Dashboard): IGatewayDashboardStore {
  return {
    create: vi.fn(),
    findById: vi.fn(async () => dash),
    findAll: vi.fn(async () => [dash]),
    listByWorkspace: vi.fn(async () => [dash]),
    update: vi.fn(async () => dash),
    updateStatus: vi.fn(),
    updatePanels: vi.fn(async (_id: string, panels: PanelConfig[]) => ({ ...dash, panels })),
    updateVariables: vi.fn(),
    delete: vi.fn(async () => true),
    getFolderUid: vi.fn(async () => null),
    size: vi.fn(async () => 0),
    clear: vi.fn(),
    toJSON: vi.fn(async () => []),
    loadJSON: vi.fn(),
  } as unknown as IGatewayDashboardStore;
}

function makeApp(
  store: IGatewayDashboardStore,
  panelEvents: IPanelEventRepository,
  env: NodeJS.ProcessEnv = {},
) {
  const accessControl: AccessControlSurface = {
    evaluate: vi.fn(async () => true),
    getUserPermissions: vi.fn(async () => []),
    ensurePermissions: vi.fn(async () => []),
    filterByPermission: vi.fn(async (_id, items) => [...items]),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/dashboards',
    createDashboardRouter({
      store,
      accessControl,
      setupConfig: { listConnectors: vi.fn() } as unknown as SetupConfigService,
      panelEvents,
      env,
    }),
  );
  return app;
}

// Recording is fire-and-forget via Promise.resolve().then(...). Tests need to
// drain the microtask queue before asserting.
async function flush() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe('panel-event recording on dashboard CRUD', () => {
  let repo: FakePanelEventRepo;

  beforeEach(() => {
    repo = new FakePanelEventRepo();
  });

  it('POST /:id/panels records a created event', async () => {
    const app = makeApp(makeStore(dashboard()), repo);
    const res = await request(app)
      .post('/dashboards/dash_1/panels')
      .send({ title: 'New', visualization: 'stat', queries: [{ refId: 'A', expr: 'up' }], row: 0, col: 0, width: 3, height: 3 });
    expect(res.status).toBe(201);
    await flush();
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]!.eventType).toBe('created');
    expect(repo.records[0]!.querySignature).toBe('up');
    expect(repo.records[0]!.vizType).toBe('stat');
    expect(repo.records[0]!.actorId).toBe('user_1');
  });

  it('DELETE /:id/panels/:panelId records a deleted event for that panel', async () => {
    const app = makeApp(makeStore(dashboard()), repo);
    const res = await request(app).delete('/dashboards/dash_1/panels/panel_1');
    expect(res.status).toBe(204);
    await flush();
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]!.eventType).toBe('deleted');
    expect(repo.records[0]!.panelId).toBe('panel_1');
  });

  it('PUT /:id/panels emits created/edited/deleted by diffing', async () => {
    const before = [panel({ id: 'a' }), panel({ id: 'b', title: 'Old' })];
    const after = [panel({ id: 'b', title: 'New' }), panel({ id: 'c' })];
    const app = makeApp(makeStore(dashboard({ panels: before })), repo);
    const res = await request(app).put('/dashboards/dash_1/panels').send({ panels: after });
    expect(res.status).toBe(200);
    await flush();
    const byType = repo.records.reduce<Record<string, number>>((acc, r) => {
      acc[r.eventType] = (acc[r.eventType] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType['edited']).toBe(1); // b changed
    expect(byType['created']).toBe(1); // c added
    expect(byType['deleted']).toBe(1); // a removed
  });

  it('DELETE /:id records deleted for every panel', async () => {
    const app = makeApp(makeStore(dashboard({ panels: [panel({ id: 'a' }), panel({ id: 'b' })] })), repo);
    const res = await request(app).delete('/dashboards/dash_1');
    expect(res.status).toBe(204);
    await flush();
    expect(repo.records.filter((r) => r.eventType === 'deleted')).toHaveLength(2);
  });

  it('POST /:id/fork records cloned events for source panels', async () => {
    const source = dashboard({ panels: [panel({ id: 'a' }), panel({ id: 'b' })] });
    const store = makeStore(source);
    vi.mocked(store.create).mockResolvedValue({ ...source, id: 'dash_fork' });
    vi.mocked(store.findById)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ ...source, id: 'dash_fork' });
    const app = makeApp(store, repo);
    const res = await request(app).post('/dashboards/dash_1/fork').send({});
    expect(res.status).toBe(201);
    await flush();
    expect(repo.records.every((r) => r.eventType === 'cloned')).toBe(true);
    expect(repo.records).toHaveLength(2);
    // Cloned events attach to the new dashboard id, not the source.
    expect(repo.records[0]!.dashboardId).toBe('dash_fork');
  });

  it('GET /:id does NOT record viewed by default', async () => {
    const app = makeApp(makeStore(dashboard()), repo);
    const res = await request(app).get('/dashboards/dash_1');
    expect(res.status).toBe(200);
    await flush();
    expect(repo.records).toHaveLength(0);
  });

  it('GET /:id records viewed when PANEL_EVENT_VIEW_TRACKING=1', async () => {
    const app = makeApp(makeStore(dashboard()), repo, { PANEL_EVENT_VIEW_TRACKING: '1' });
    const res = await request(app).get('/dashboards/dash_1');
    expect(res.status).toBe(200);
    await flush();
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]!.eventType).toBe('viewed');
  });

  it('marks ai_generated=true when dashboard source is ai_generated', async () => {
    const app = makeApp(makeStore(dashboard({ source: 'ai_generated' })), repo);
    const res = await request(app).delete('/dashboards/dash_1/panels/panel_1');
    expect(res.status).toBe(204);
    await flush();
    expect(repo.records[0]!.aiGenerated).toBe(true);
  });

  it('repo failures do not break the mutation response', async () => {
    const flaky: IPanelEventRepository = {
      record: vi.fn().mockRejectedValue(new Error('boom')),
      findByDashboard: vi.fn(),
      findByQuerySignature: vi.fn(),
      aggregateBySignature: vi.fn(),
    } as unknown as IPanelEventRepository;
    const app = makeApp(makeStore(dashboard()), flaky);
    const res = await request(app).delete('/dashboards/dash_1/panels/panel_1');
    expect(res.status).toBe(204);
    await flush();
    // Ensure no unhandled rejection escapes.
    expect(flaky.record).toHaveBeenCalled();
  });
});
