/**
 * Unit test for POST /api/alert-rules/:id/investigate.
 *
 * The bug this guards against: the route used to call
 * `investigationStore.create` without a `workspaceId`, so the resulting
 * investigation was unreachable from the same workspace's GET handler
 * (which filters by workspaceId) — operators saw "Investigation not
 * found" after clicking Investigate. The fix passes the rule's
 * workspaceId through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AlertRule } from '@agentic-obs/common';
import type { Identity } from '@agentic-obs/common';
import { setAuthMiddleware } from '../middleware/auth.js';
import { createAlertRulesRouter } from './alert-rules.js';

const ALWAYS_ALLOW: { evaluate: () => Promise<true>; eval: (...a: unknown[]) => unknown } = {
  evaluate: async () => true as const,
  eval: () => ({}),
};

const SETUP_CONFIG_STUB = {} as unknown as ConstructorParameters<
  typeof import('../services/alert-rule-service.js').AlertRuleService
>[1];

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'r1',
    name: 'Test Rule',
    description: '',
    condition: { query: 'up', operator: '<', threshold: 1, forDurationSec: 0 },
    evaluationIntervalSec: 60,
    severity: 'high',
    labels: {},
    state: 'firing',
    stateChangedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fireCount: 1,
    workspaceId: 'ws_team_a',
    ...overrides,
  } as AlertRule;
}

function makeApp(opts: {
  rule: AlertRule | null;
  identity: Identity;
  capturedCreate: ReturnType<typeof vi.fn>;
}) {
  const store = {
    findById: vi.fn(async () => opts.rule),
    update: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof createAlertRulesRouter>[0]['alertRuleStore'];

  const investigationStore = {
    create: opts.capturedCreate,
  } as unknown as Parameters<typeof createAlertRulesRouter>[0]['investigationStore'];

  const app = express();
  app.use(express.json());
  // Inject identity per-app before the router. The router's internal
  // authMiddleware reads a module-level resolvedMiddleware (set in the
  // beforeAll hook to a passthrough); since req.auth is already populated
  // here, the passthrough is a no-op and the router proceeds with the
  // intended identity. This pattern is robust to vitest worker-thread
  // module sharing — any other test file that mutates the global cannot
  // strip req.auth that's already set on this request.
  app.use((req, _res, next) => {
    (req as express.Request & { auth?: Identity }).auth = opts.identity;
    next();
  });
  app.use(
    '/api/alert-rules',
    createAlertRulesRouter({
      alertRuleStore: store,
      investigationStore,
      setupConfig: SETUP_CONFIG_STUB,
      ac: ALWAYS_ALLOW as unknown as Parameters<typeof createAlertRulesRouter>[0]['ac'],
    }),
  );
  return app;
}

describe('POST /api/alert-rules/:id/investigate', () => {
  beforeEach(() => {
    // Replace the global auth middleware with a passthrough so the
    // router's internal `authMiddleware` call is a no-op and won't
    // overwrite req.auth that the per-app middleware (in makeApp) sets.
    setAuthMiddleware((_req, _res, next) => { next(); });
  });

  it('passes the rule\'s workspaceId to investigationStore.create', async () => {
    const create = vi.fn(async (input: { workspaceId?: string }) => ({
      id: 'inv_1',
      workspaceId: input.workspaceId,
    }));
    const app = makeApp({
      rule: makeRule({ workspaceId: 'ws_team_a' }),
      identity: { userId: 'u1', orgId: 'ws_team_a', orgRole: 'Editor', isServerAdmin: false, authenticatedBy: 'session' },
      capturedCreate: create,
    });

    const res = await request(app)
      .post('/api/alert-rules/r1/investigate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ investigationId: 'inv_1', existing: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown[])?.[0]).toMatchObject({ workspaceId: 'ws_team_a' });
  });

  it('falls back to the requester\'s workspace when the rule has none', async () => {
    const create = vi.fn(async () => ({ id: 'inv_2' }));
    const app = makeApp({
      rule: makeRule({ workspaceId: undefined }),
      identity: { userId: 'u1', orgId: 'org_main', orgRole: 'Editor', isServerAdmin: false, authenticatedBy: 'session' },
      capturedCreate: create,
    });

    await request(app)
      .post('/api/alert-rules/r1/investigate')
      .send({})
      .expect(200);

    expect((create.mock.calls[0] as unknown[])?.[0]).toMatchObject({ workspaceId: 'org_main' });
  });
});
