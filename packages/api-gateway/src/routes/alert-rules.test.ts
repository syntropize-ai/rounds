import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AlertRule, GrafanaFolder, Identity, IFolderRepository } from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { createAlertRulesRouter } from './alert-rules.js';

const DEFAULT_ALERT_RULE_FOLDER_UID = 'alerts';

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

function makeFolderRepo(): IFolderRepository {
  const folders = new Map<string, GrafanaFolder>();
  return {
    create: vi.fn(async (input) => {
      const folder: GrafanaFolder = {
        id: input.uid,
        uid: input.uid,
        orgId: input.orgId,
        title: input.title,
        description: input.description ?? null,
        parentUid: input.parentUid ?? null,
        created: '2026-04-30T00:00:00.000Z',
        updated: '2026-04-30T00:00:00.000Z',
        createdBy: input.createdBy ?? null,
        updatedBy: input.updatedBy ?? null,
      };
      folders.set(`${folder.orgId}:${folder.uid}`, folder);
      return folder;
    }),
    findById: vi.fn(async () => null),
    findByUid: vi.fn(async (orgId, uid) => folders.get(`${orgId}:${uid}`) ?? null),
    list: vi.fn(async () => ({ items: [...folders.values()], total: folders.size })),
    listAncestors: vi.fn(async () => []),
    listChildren: vi.fn(async () => []),
    update: vi.fn(async () => null),
    delete: vi.fn(async () => true),
  };
}

function makeApp(store = makeStore(), folderRepository: IFolderRepository = makeFolderRepo()) {
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
    setupConfig: {} as SetupConfigService,
    ac: accessControl,
    folderRepository,
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

  it('creates a default Alerts folder when POST /alert-rules omits folderUid', async () => {
    const store = makeStore();
    const folderRepository = makeFolderRepo();
    const { app } = makeApp(store, folderRepository);

    const res = await request(app)
      .post('/alert-rules')
      .send({
        name: 'CPUHigh',
        condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
      });

    expect(res.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      folderUid: DEFAULT_ALERT_RULE_FOLDER_UID,
      workspaceId: 'org_a',
    }));
    expect(folderRepository.findByUid).toHaveBeenCalledWith('org_a', DEFAULT_ALERT_RULE_FOLDER_UID);
    expect(folderRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      uid: DEFAULT_ALERT_RULE_FOLDER_UID,
      title: 'Alerts',
      orgId: 'org_a',
    }));
  });
});
