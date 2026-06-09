/**
 * Unit test for POST /api/alert-rules/:id/investigate.
 *
 * Manual alert investigation should behave like normal agent-created
 * investigations: queue the agent first, then link the final persisted
 * investigation after the agent completes. It must not pre-create an empty
 * operator-visible investigation row.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AlertRule } from '@agentic-obs/common';
import type { Identity } from '@agentic-obs/common';

// Replace the module-level authMiddleware (which delegates to a global
// resolvedMiddleware mutable across the process) with a passthrough.
// vi.mock isolates per-test-file regardless of vitest worker reuse, so
// other test files that mutate the global cannot strip req.auth that
// our per-app middleware in makeApp() sets below.
vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  };
});

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
  finalInvestigations?: Array<{
    id: string;
    intent: string;
    createdAt: string;
    workspaceId?: string;
  }>;
  runner?: Parameters<typeof createAlertRulesRouter>[0]['runner'];
  manualInvestigationTimeoutMs?: number;
}) {
  const store = {
    findById: vi.fn(async () => opts.rule),
    update: vi.fn(async () => opts.rule),
  } as unknown as Parameters<typeof createAlertRulesRouter>[0]['alertRuleStore'];

  let findByWorkspaceCalls = 0;
  const investigationStore = {
    create: opts.capturedCreate,
    findByWorkspace: vi.fn(async () => {
      findByWorkspaceCalls += 1;
      return findByWorkspaceCalls === 1 ? [] : opts.finalInvestigations ?? [];
    }),
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
      ...(opts.runner ? { runner: opts.runner } : {}),
      ...(opts.manualInvestigationTimeoutMs !== undefined
        ? { manualInvestigationTimeoutMs: opts.manualInvestigationTimeoutMs }
        : {}),
    }),
  );
  return { app, store, investigationStore };
}

function makeRunner() {
  const fakeOrchestrator = {
    handleMessage: vi.fn(async () => 'done'),
  } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>['makeOrchestrator']>>;
  return {
    saTokens: { validateAndLookup: vi.fn() } as unknown as NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>['saTokens'],
    makeOrchestrator: vi.fn(async () => fakeOrchestrator),
  } as NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>;
}

describe('POST /api/alert-rules/:id/investigate', () => {
  it('queues background investigation without pre-creating an empty row', async () => {
    const create = vi.fn(async () => ({ id: 'inv_should_not_be_created' }));
    const { app } = makeApp({
      rule: makeRule({ workspaceId: 'ws_team_a' }),
      identity: { userId: 'u1', orgId: 'ws_team_a', orgRole: 'Editor', isServerAdmin: false, authenticatedBy: 'session' },
      capturedCreate: create,
      runner: makeRunner(),
    });

    const res = await request(app)
      .post('/api/alert-rules/r1/investigate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: true, existing: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects manual investigate when no background runner is configured', async () => {
    const create = vi.fn(async () => ({ id: 'inv_not_created' }));
    const { app } = makeApp({
      rule: makeRule({ workspaceId: 'ws_team_a' }),
      identity: { userId: 'u1', orgId: 'ws_team_a', orgRole: 'Editor', isServerAdmin: false, authenticatedBy: 'session' },
      capturedCreate: create,
    });

    const res = await request(app)
      .post('/api/alert-rules/r1/investigate')
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'NOT_CONFIGURED',
      message: 'Background investigation runner not configured',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('spawns under the clicker identity and links the final saved investigation', async () => {
    const create = vi.fn(async () => ({ id: 'inv_run_1' }));
    // Promise we resolve when the orchestrator's handleMessage is called.
    // This proves the route actually kicks off the agent path (not just
    // creates the row).
    let agentCalledResolve: (msg: { identity: Identity; message: string; status: string }) => void = () => {};
    const agentCalled = new Promise<{ identity: Identity; message: string; status: string }>((r) => { agentCalledResolve = r; });
    let observedStatus = 'planning';

    const identity: Identity = {
      userId: 'u_alice',
      orgId: 'ws_team_a',
      orgRole: 'Editor',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };

    const fakeOrchestrator = {
      handleMessage: vi.fn(async (message: string) => {
        // Mock the agent doing its work and advancing status.
        observedStatus = 'completed';
        agentCalledResolve({ identity, message, status: observedStatus });
        return 'done';
      }),
    } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>['makeOrchestrator']>>;

    const runner = {
      saTokens: { validateAndLookup: vi.fn() } as unknown as NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>['saTokens'],
      makeOrchestrator: vi.fn(async () => fakeOrchestrator),
    } as NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>;

    const question = 'Investigate alert "Test Rule": up < 1';
    const { app, store } = makeApp({
      rule: makeRule({ workspaceId: 'ws_team_a' }),
      identity,
      capturedCreate: create,
      finalInvestigations: [{
        id: 'inv_run_1',
        intent: question,
        createdAt: new Date().toISOString(),
        workspaceId: 'ws_team_a',
      }],
      runner,
    });

    const res = await request(app)
      .post('/api/alert-rules/r1/investigate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: true, existing: false });

    // The route returns immediately; the agent spawn is in-flight. Wait
    // for it to land so we can assert it actually ran.
    const observed = await agentCalled;
    expect(observed.identity.userId).toBe('u_alice');
    expect(observed.message).toContain('Test Rule');
    expect(observed.status).toBe('completed');
    expect(create).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(store.update).toHaveBeenCalledWith('r1', {
        investigationId: 'inv_run_1',
        investigationStartedAt: undefined,
        investigationFailedAt: undefined,
        investigationFailureReason: undefined,
      });
    });
  });

  it('marks the alert failed and retryable when the queued manual agent never settles', async () => {
    const create = vi.fn(async () => ({ id: 'inv_should_not_be_created' }));
    const fakeOrchestrator = {
      handleMessage: vi.fn(() => new Promise<string>(() => {})),
    } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>['makeOrchestrator']>>;
    const runner = {
      saTokens: { validateAndLookup: vi.fn() } as unknown as NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>['saTokens'],
      makeOrchestrator: vi.fn(async () => fakeOrchestrator),
    } as NonNullable<Parameters<typeof createAlertRulesRouter>[0]['runner']>;
    const { app, store } = makeApp({
      rule: makeRule({ workspaceId: 'ws_team_a' }),
      identity: { userId: 'u1', orgId: 'ws_team_a', orgRole: 'Editor', isServerAdmin: false, authenticatedBy: 'session' },
      capturedCreate: create,
      runner,
      manualInvestigationTimeoutMs: 1,
    });

    const res = await request(app)
      .post('/api/alert-rules/r1/investigate')
      .send({});

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(store.update).toHaveBeenCalledWith('r1', {
        investigationStartedAt: undefined,
        investigationFailedAt: expect.any(String),
        investigationFailureReason: 'Manual alert investigation timed out after 1ms.',
      });
    });
    expect(create).not.toHaveBeenCalled();
  });

  // Removed: 'falls back to the requester's workspace when the rule has none'.
  // The audit fix in #126 tightened loadOwnedRule to a strict workspaceId
  // equality check — rules without a workspaceId are now 404, not silently
  // adopted by the requester's org. The fallback contract this test asserted
  // no longer exists; keeping the test would gate CI on dead behavior.
});
