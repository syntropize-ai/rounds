import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const promRangeQueryMock = vi.hoisted(() => vi.fn());
vi.mock('@agentic-obs/adapters', async () => {
  const actual = await vi.importActual<typeof import('@agentic-obs/adapters')>('@agentic-obs/adapters');
  return {
    ...actual,
    PrometheusMetricsAdapter: class {
      rangeQuery = promRangeQueryMock;
    },
  };
});
import type { AlertRule, Identity } from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { createAlertRulesRouter } from './alert-rules.js';

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

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule_a',
    name: 'HighErrorRate',
    description: '',
    condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
    evaluationIntervalSec: 60,
    severity: 'high',
    state: 'normal',
    stateChangedAt: '2026-04-30T00:00:00.000Z',
    workspaceId: 'org_a',
    createdBy: 'user_1',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    fireCount: 0,
    ...overrides,
  };
}

function makeStore(): IAlertRuleRepository {
  return {
    findById: vi.fn(async (id: string) => {
      if (id === 'rule_a') return rule({ id, workspaceId: 'org_a' });
      if (id === 'rule_b') return rule({ id, workspaceId: 'org_b' });
      return undefined;
    }),
    findAll: vi.fn(async () => ({ list: [rule()], total: 1 })),
    findByWorkspace: vi.fn(async () => []),
    create: vi.fn(async (data) => rule({ ...data, id: 'created' } as Partial<AlertRule>)),
    update: vi.fn(async (id, patch) => rule({ id, ...patch })),
    delete: vi.fn(async () => true),
    transition: vi.fn(),
    getHistory: vi.fn(async () => []),
    getAllHistory: vi.fn(async () => []),
    createSilence: vi.fn(),
    findSilences: vi.fn(async () => []),
    findAllSilencesIncludingExpired: vi.fn(async () => []),
    updateSilence: vi.fn(),
    deleteSilence: vi.fn(),
    createPolicy: vi.fn(),
    findAllPolicies: vi.fn(async () => []),
    findPolicyById: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
    getFolderUid: vi.fn(async () => null),
  } as unknown as IAlertRuleRepository;
}

function makeApp(
  store = makeStore(),
  setupConfig: Partial<SetupConfigService> = {},
) {
  const accessControl: AccessControlSurface = {
    evaluate: vi.fn(async () => true),
    getUserPermissions: vi.fn(async () => []),
    ensurePermissions: vi.fn(async () => []),
    filterByPermission: vi.fn(async (_identity, items) => [...items]),
  };
  const app = express();
  app.use(express.json());
  app.use('/alert-rules', createAlertRulesRouter({
    alertRuleStore: store,
    setupConfig: setupConfig as SetupConfigService,
    ac: accessControl,
  }));
  return { app, store, accessControl };
}

describe('alert rules router ownership checks', () => {
  beforeEach(() => {
    authState.orgId = 'org_a';
    vi.clearAllMocks();
  });

  it('hides cross-org rule reads', async () => {
    const { app } = makeApp();

    const res = await request(app).get('/alert-rules/rule_b');

    expect(res.status).toBe(404);
  });

  it.each([
    ['put', '/alert-rules/rule_b', { severity: 'low' }, 'update'],
    ['delete', '/alert-rules/rule_b', undefined, 'delete'],
    ['post', '/alert-rules/rule_b/disable', undefined, 'update'],
    ['post', '/alert-rules/rule_b/enable', undefined, 'update'],
  ] as const)('blocks cross-org mutation for %s %s', async (method, path, body, mutation) => {
    const { app, store } = makeApp();
    let req = request(app)[method](path);
    if (body) req = req.send(body);

    const res = await req;

    expect(res.status).toBe(404);
    expect(store[mutation]).not.toHaveBeenCalled();
  });

  it('blocks cross-org history reads before querying history rows', async () => {
    const { app, store } = makeApp();

    const res = await request(app).get('/alert-rules/rule_b/history');

    expect(res.status).toBe(404);
    expect(store.getHistory).not.toHaveBeenCalled();
  });

  it('POST /alert-rules without folderUid creates a root-level rule (folderUid omitted)', async () => {
    const store = makeStore();
    const { app } = makeApp(store);

    const res = await request(app)
      .post('/alert-rules')
      .send({
        name: 'CPUHigh',
        condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
      });

    expect(res.status).toBe(201);
    const createCall = (store.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(createCall).toMatchObject({ name: 'CPUHigh', workspaceId: 'org_a' });
    // Grafana parity: no auto-folder. folderUid should not be set.
    expect('folderUid' in createCall).toBe(false);
  });

  it('POST /alert-rules with folderUid passes it through unchanged', async () => {
    const store = makeStore();
    const { app } = makeApp(store);

    const res = await request(app)
      .post('/alert-rules')
      .send({
        name: 'CPUHigh',
        folderUid: 'team-payments',
        condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
      });

    expect(res.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      folderUid: 'team-payments',
      workspaceId: 'org_a',
    }));
  });
});

describe('POST /alert-rules/preview', () => {
  beforeEach(() => {
    authState.orgId = 'org_a';
    promRangeQueryMock.mockReset();
    vi.clearAllMocks();
  });

  function withProm(): Partial<SetupConfigService> {
    return {
      listConnectors: vi.fn(async () => [{
        id: 'ds_prom',
        type: 'prometheus',
        name: 'prom',
        config: { url: 'http://prom:9090' },
        orgId: 'org_a',
        isDefault: true,
      } as never]),
    };
  }

  it('returns wouldHaveFired and sample timestamps on happy path', async () => {
    const t0 = 1_700_000_000;
    promRangeQueryMock.mockResolvedValueOnce([
      {
        metric: { __name__: 'up', instance: 'a' },
        values: [
          [t0, '0.1'],     // below threshold
          [t0 + 60, '0.9'], // above
          [t0 + 120, '0.95'], // above
        ],
      },
    ]);
    const { app } = makeApp(makeStore(), withProm());

    const res = await request(app)
      .post('/alert-rules/preview')
      .send({ query: 'up', comparator: '>', threshold: 0.5, lookbackHours: 24 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'ok',
      wouldHaveFired: 2,
      seriesCount: 1,
      lookbackHours: 24,
    });
    expect(res.body.sampleTimestamps).toHaveLength(2);
  });

  it('returns missing_capability when no metrics datasource is configured', async () => {
    const { app } = makeApp(makeStore(), {
      listConnectors: vi.fn(async () => []),
    });

    const res = await request(app)
      .post('/alert-rules/preview')
      .send({ query: 'up', comparator: '>', threshold: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'missing_capability', reason: 'no_metrics_datasource' });
    expect(promRangeQueryMock).not.toHaveBeenCalled();
  });

  it('returns no_series reason when query returns nothing in the lookback window', async () => {
    promRangeQueryMock.mockResolvedValueOnce([]);
    const { app } = makeApp(makeStore(), withProm());

    const res = await request(app)
      .post('/alert-rules/preview')
      .send({ query: 'up', comparator: '>', threshold: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'ok',
      wouldHaveFired: 0,
      sampleTimestamps: [],
      seriesCount: 0,
      lookbackHours: 24,
      reason: 'no_series',
    });
  });

  it('rejects invalid input with 400', async () => {
    const { app } = makeApp(makeStore(), withProm());

    const res = await request(app)
      .post('/alert-rules/preview')
      .send({ query: 'up', comparator: '??', threshold: 1 });

    expect(res.status).toBe(400);
  });
});

describe('GET /alert-rules pagination across workspaces', () => {
  // Rows from both workspaces interleaved, as on a shared instance.
  const seeded = [
    rule({ id: 'a1', workspaceId: 'org_a' }),
    rule({ id: 'b1', workspaceId: 'org_b' }),
    rule({ id: 'a2', workspaceId: 'org_a' }),
    rule({ id: 'b2', workspaceId: 'org_b' }),
    rule({ id: 'a3', workspaceId: 'org_a' }),
  ];

  // Store double honouring the repository contract: filter first, then
  // total, then offset/limit.
  function makeSeededStore(): IAlertRuleRepository {
    const store = makeStore();
    store.findAll = vi.fn(async (filter?: { workspaceId?: string; limit?: number; offset?: number }) => {
      const matched = filter?.workspaceId
        ? seeded.filter((r) => r.workspaceId === filter.workspaceId)
        : seeded;
      let list = matched;
      if (filter?.offset) list = list.slice(filter.offset);
      if (filter?.limit) list = list.slice(0, filter.limit);
      return { list, total: matched.length };
    });
    return store;
  }

  beforeEach(() => {
    authState.orgId = 'org_a';
    vi.clearAllMocks();
  });

  it('passes the workspace down to the store instead of filtering the page', async () => {
    const { app, store } = makeApp(makeSeededStore());

    await request(app).get('/alert-rules?limit=1&offset=0');

    expect(store.findAll).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'org_a' }));
  });

  it.each([0, 1, 2])('returns the workspace total and no foreign rows at offset %i', async (offset) => {
    const { app } = makeApp(makeSeededStore());

    const res = await request(app).get(`/alert-rules?limit=1&offset=${offset}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.list).toHaveLength(1);
    expect(res.body.list.every((r: AlertRule) => r.workspaceId === 'org_a')).toBe(true);
  });

  it('pages the other workspace independently', async () => {
    authState.orgId = 'org_b';
    const { app } = makeApp(makeSeededStore());

    const res = await request(app).get('/alert-rules?limit=1&offset=1');

    expect(res.body.total).toBe(2);
    expect(res.body.list.map((r: AlertRule) => r.id)).toEqual(['b2']);
  });
});
