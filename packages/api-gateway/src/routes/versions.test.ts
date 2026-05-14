import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AssetVersion, Dashboard, Evaluator, IDashboardRepository, Identity, ResolvedPermission } from '@agentic-obs/common';
import type {
  IAlertRuleRepository,
  IInvestigationReportRepository,
  IVersionRepository,
} from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { createVersionRouter } from './versions.js';

const authState = vi.hoisted(() => ({ orgId: 'org_a' }));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request & { auth?: Identity }, _res: express.Response, next: express.NextFunction) => {
    req.auth = {
      userId: 'user_1',
      orgId: authState.orgId,
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  },
}));

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash_a',
    type: 'dashboard',
    title: 'Dash',
    description: '',
    prompt: '',
    userId: 'user_1',
    status: 'ready',
    panels: [],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    workspaceId: 'org_a',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

function version(): AssetVersion {
  return {
    id: 'ver_1',
    assetType: 'dashboard',
    assetId: 'dash_a',
    version: 1,
    snapshot: { title: 'Dash' },
    editedBy: 'user_1',
    editSource: 'human',
    createdAt: '2026-04-30T00:00:00.000Z',
  };
}

function makeStores() {
  const versions: IVersionRepository = {
    record: vi.fn(),
    getHistory: vi.fn(async () => [version()]),
    getVersion: vi.fn(async () => version()),
    getLatest: vi.fn(),
    rollback: vi.fn(async () => ({ title: 'Dash' })),
  };
  const dashboards = {
    findById: vi.fn(async (id: string) => {
      if (id === 'dash_a') return dashboard({ id, workspaceId: 'org_a' });
      if (id === 'dash_b') return dashboard({ id, workspaceId: 'org_b' });
      return undefined;
    }),
  } as Partial<IDashboardRepository> as IDashboardRepository;
  const alertRules = {
    findById: vi.fn(async (id: string) => {
      if (id === 'alert_a') return { id, workspaceId: 'org_a' };
      if (id === 'alert_b') return { id, workspaceId: 'org_b' };
      return undefined;
    }),
  } as Partial<IAlertRuleRepository> as IAlertRuleRepository;
  const investigationReports = {
    findById: vi.fn(async (id: string) => {
      if (id === 'report_a') return { id, dashboardId: 'dash_a', goal: '', summary: '', sections: [], createdAt: '' };
      if (id === 'report_b') return { id, dashboardId: 'dash_b', goal: '', summary: '', sections: [], createdAt: '' };
      return undefined;
    }),
  } as Partial<IInvestigationReportRepository> as IInvestigationReportRepository;
  return { versions, dashboards, alertRules, investigationReports };
}

function makeApp(stores = makeStores(), allow = true) {
  const accessControl: AccessControlSurface = {
    evaluate: vi.fn(async (_id: Identity, _evaluator: Evaluator) => allow),
    getUserPermissions: vi.fn(async (): Promise<ResolvedPermission[]> => []),
    ensurePermissions: vi.fn(async (): Promise<ResolvedPermission[]> => []),
    filterByPermission: vi.fn(async (_identity, items) => [...items]),
  };

  const app = express();
  app.use(express.json());
  app.use('/versions', createVersionRouter({
    store: stores.versions,
    dashboards: stores.dashboards,
    alertRules: stores.alertRules,
    investigationReports: stores.investigationReports,
    ac: accessControl,
  }));
  return { app, stores, accessControl };
}

describe('version router asset scoping', () => {
  beforeEach(() => {
    authState.orgId = 'org_a';
    vi.clearAllMocks();
  });

  it('returns version history for an owned dashboard', async () => {
    const { app, stores } = makeApp();

    const res = await request(app).get('/versions/dashboard/dash_a');

    expect(res.status).toBe(200);
    expect(stores.versions.getHistory).toHaveBeenCalledWith('dashboard', 'dash_a');
  });

  it('hides cross-org dashboard versions before reading version rows', async () => {
    const { app, stores } = makeApp();

    const res = await request(app).get('/versions/dashboard/dash_b');

    expect(res.status).toBe(404);
    expect(stores.versions.getHistory).not.toHaveBeenCalled();
  });

  it('checks alert rule ownership and alert-rule permission for alert versions', async () => {
    const { app, stores, accessControl } = makeApp();

    const res = await request(app).get('/versions/alert_rule/alert_a/1');

    expect(res.status).toBe(200);
    expect(stores.versions.getVersion).toHaveBeenCalledWith('alert_rule', 'alert_a', 1);
    const evaluator = vi.mocked(accessControl.evaluate).mock.calls[0]?.[1];
    expect(evaluator?.string()).toContain('alert.rules:read');
  });

  it('hides cross-org investigation report versions through the linked dashboard', async () => {
    const { app, stores } = makeApp();

    const res = await request(app).get('/versions/investigation_report/report_b');

    expect(res.status).toBe(404);
    expect(stores.versions.getHistory).not.toHaveBeenCalled();
  });

  it('denies rollback when asset write permission is missing', async () => {
    const { app, stores } = makeApp(makeStores(), false);

    const res = await request(app)
      .post('/versions/dashboard/dash_a/rollback')
      .send({ version: 1 });

    expect(res.status).toBe(403);
    expect(stores.versions.rollback).not.toHaveBeenCalled();
  });
});
