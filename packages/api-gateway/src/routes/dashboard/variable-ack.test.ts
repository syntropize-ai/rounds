/**
 * Wave 2 / Step 4 — variable-inference ack endpoint integration tests.
 *
 * Covers:
 *   - first GET → acked:false; POST → 200; second GET (same hash) → acked:true
 *   - GET with a different hash after acking → acked:false (banner returns)
 *   - 400 on bad request bodies
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Dashboard } from '@agentic-obs/common';
import { hashVariables } from '../../../../common/src/utils/variable-hash.js';
import { InMemoryDashboardVariableAckRepository } from '../../../../data-layer/src/repository/memory/dashboard-variable-ack.js';
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer';

// Patch the @agentic-obs/common module resolution so the router under test
// uses the worktree-local hashVariables (the dist at the workspace symlink
// target is built from an older revision that doesn't ship the helper).
// Vitest's vi.mock with the canonical specifier ensures the same module
// instance is returned regardless of which file imports it.
import * as commonLocal from '../../../../common/src/index.js';
vi.mock('@agentic-obs/common', () => commonLocal);
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../../services/setup-config-service.js';
import { createDashboardRouter } from './router.js';

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: req.headers['x-test-user'] ?? 'user_1',
      orgId: 'org_main',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  },
}));

function dashboard(): Dashboard {
  return {
    id: 'dash_1',
    type: 'dashboard',
    title: 'D',
    description: '',
    prompt: '',
    userId: 'user_1',
    status: 'ready',
    panels: [],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    workspaceId: 'org_main',
    source: 'manual',
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
  };
}

function makeStore(d: Dashboard): IGatewayDashboardStore {
  return {
    create: vi.fn(),
    findById: vi.fn(async () => d),
    findAll: vi.fn(async () => [d]),
    listByWorkspace: vi.fn(async () => [d]),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updatePanels: vi.fn(),
    updateVariables: vi.fn(),
    delete: vi.fn(),
    getFolderUid: vi.fn(async () => null),
    size: vi.fn(async () => 0),
    clear: vi.fn(),
    toJSON: vi.fn(async () => []),
    loadJSON: vi.fn(),
  } as unknown as IGatewayDashboardStore;
}

function makeApp(opts: { variableAcks?: InMemoryDashboardVariableAckRepository } = {}) {
  const accessControl: AccessControlSurface = {
    evaluate: vi.fn(async () => true),
    getUserPermissions: vi.fn(async () => []),
    ensurePermissions: vi.fn(async () => []),
    filterByPermission: vi.fn(async (_identity, items) => [...items]),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/dashboards',
    createDashboardRouter({
      store: makeStore(dashboard()),
      accessControl,
      setupConfig: { listConnectors: vi.fn() } as unknown as SetupConfigService,
      variableAcks: opts.variableAcks,
    }),
  );
  return app;
}

describe('GET/POST /dashboards/:uid/variable-ack', () => {
  it('first GET returns acked:false; POST then GET returns acked:true', async () => {
    const variableAcks = new InMemoryDashboardVariableAckRepository();
    const app = makeApp({ variableAcks });

    const vars = { service: 'ingress', namespace: 'prod' };
    const hash = hashVariables(vars);

    const before = await request(app).get(`/dashboards/dash_1/variable-ack?vars=${hash}`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ acked: false });

    const post = await request(app)
      .post('/dashboards/dash_1/variable-ack')
      .send({ vars });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ acked: true });

    const after = await request(app).get(`/dashboards/dash_1/variable-ack?vars=${hash}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ acked: true });
  });

  it('different vars hash after ack still returns acked:false', async () => {
    const variableAcks = new InMemoryDashboardVariableAckRepository();
    const app = makeApp({ variableAcks });

    await request(app)
      .post('/dashboards/dash_1/variable-ack')
      .send({ vars: { service: 'ingress' } });

    const otherHash = hashVariables({ service: 'payments' });
    const res = await request(app).get(`/dashboards/dash_1/variable-ack?vars=${otherHash}`);
    expect(res.body).toEqual({ acked: false });
  });

  it('POST rejects non-object vars', async () => {
    const variableAcks = new InMemoryDashboardVariableAckRepository();
    const app = makeApp({ variableAcks });
    const res = await request(app)
      .post('/dashboards/dash_1/variable-ack')
      .send({ vars: 'nope' });
    expect(res.status).toBe(400);
  });

  it('POST rejects non-string values', async () => {
    const variableAcks = new InMemoryDashboardVariableAckRepository();
    const app = makeApp({ variableAcks });
    const res = await request(app)
      .post('/dashboards/dash_1/variable-ack')
      .send({ vars: { service: 1 } });
    expect(res.status).toBe(400);
  });

  it('GET requires vars query param', async () => {
    const variableAcks = new InMemoryDashboardVariableAckRepository();
    const app = makeApp({ variableAcks });
    const res = await request(app).get('/dashboards/dash_1/variable-ack');
    expect(res.status).toBe(400);
  });

  it('returns 503 when repo is not wired', async () => {
    const app = makeApp({});
    const res = await request(app).get('/dashboards/dash_1/variable-ack?vars=abc');
    expect(res.status).toBe(503);
  });
});
