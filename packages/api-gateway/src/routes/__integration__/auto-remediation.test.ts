/**
 * E2E integration test (design-doc T8.6) for the auto-remediation chain.
 *
 * Two scenarios across the full glue:
 *
 *   A. Plan flow — persist a plan via the agent handler, approve via the
 *      REST router, drive PlanExecutorService through a mock adapter,
 *      assert the plan reaches `completed` with all steps `done` and
 *      audit rows on disk.
 *
 *   B. Alert dispatcher — emit `alert.fired` on AlertEvaluatorService,
 *      AutoInvestigationDispatcher receives it and spawns the
 *      background-agent runner. spawnAgent is stubbed so we don't have
 *      to stand up a real LLM orchestrator. Assert the spawn was called
 *      with the seeded SA token + a question composed from the alert
 *      payload.
 *
 * The unit-level coverage for each piece already exists; this file is
 * about the *connections* between them.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express, { type Application } from 'express';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import {
  createTestDb,
  SqliteRemediationPlanRepository,
  SqliteApprovalRequestRepository,
  AuditLogRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { ExecutionAdapter } from '@agentic-obs/adapters';
import type { Identity } from '@agentic-obs/common';
import { createPlansRouter } from '../plans.js';
import { PlanExecutorService } from '../../services/plan-executor-service.js';
import { AuditWriter } from '../../auth/audit-writer.js';
import {
  AutoInvestigationDispatcher,
  buildAlertQuestion,
} from '../../services/auto-investigation-dispatcher.js';
import type { AlertFiredPayload } from '../../services/alert-evaluator-service.js';
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import { setAuthMiddleware } from '../../middleware/auth.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORG = 'org_main';

function identity(over: Partial<Identity> = {}): Identity {
  return {
    userId: 'u_1',
    orgId: ORG,
    orgRole: 'Editor',
    isServerAdmin: false,
    authenticatedBy: 'session',
    ...over,
  };
}

/**
 * Permissive AC surface that says yes to everything. Per-route RBAC is
 * tested elsewhere; here we focus on the data + state-machine wiring.
 */
const allowAllAc: AccessControlSurface = {
  getUserPermissions: async () => [],
  evaluate: async () => true,
  ensurePermissions: async () => [],
  filterByPermission: async (_id, rows) => [...rows],
};

interface FakeAdapter extends ExecutionAdapter {
  calls: Array<{ argv: string[] }>;
}

function fakeAdapter(opts: {
  succeed?: boolean | ((argv: string[]) => boolean);
  output?: string;
  error?: string;
} = {}): FakeAdapter {
  const calls: Array<{ argv: string[] }> = [];
  const succeed = opts.succeed ?? true;
  return {
    capabilities: () => ['k8s.read', 'k8s.write'],
    async validate() { return { valid: true }; },
    async dryRun() { return { estimatedImpact: 'ok', warnings: [], willAffect: [] }; },
    async execute(action) {
      const argv = (action.params as { argv?: string[] }).argv ?? [];
      calls.push({ argv: [...argv] });
      const ok = typeof succeed === 'function' ? succeed(argv) : succeed;
      return ok
        ? { success: true, output: opts.output ?? 'ok', rollbackable: false, executionId: 'x' }
        : { success: false, output: '', rollbackable: false, executionId: 'x', error: opts.error ?? 'failed' };
    },
    get calls() { return calls; },
  };
}

function basePlan(overrides: Parameters<SqliteRemediationPlanRepository['create']>[0] | object = {}): Parameters<SqliteRemediationPlanRepository['create']>[0] {
  return {
    orgId: ORG,
    investigationId: 'inv-1',
    summary: 'Scale web from 1 to 3 replicas',
    createdBy: 'agent',
    steps: [
      {
        kind: 'ops.run_command',
        commandText: 'kubectl scale deploy/web -n app --replicas=3',
        paramsJson: { argv: ['scale', 'deploy/web', '-n', 'app', '--replicas=3'], connectorId: 'k8s-prod' },
      },
      {
        kind: 'ops.run_command',
        commandText: 'kubectl rollout status deploy/web -n app',
        paramsJson: { argv: ['rollout', 'status', 'deploy/web', '-n', 'app'], connectorId: 'k8s-prod' },
      },
    ],
    ...(overrides as object),
  } as Parameters<SqliteRemediationPlanRepository['create']>[0];
}

// ---------------------------------------------------------------------------
// (A) Plan flow — REST + executor + adapter + audit
// ---------------------------------------------------------------------------

describe('E2E: plan flow (approve -> execute -> audit)', () => {
  let app: Application;
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  let approvalsRepo: SqliteApprovalRequestRepository;
  let auditWriter: AuditWriter;
  let auditLog: AuditLogRepository;
  let adapter: FakeAdapter;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
    approvalsRepo = new SqliteApprovalRequestRepository(db);
    auditLog = new AuditLogRepository(db);
    auditWriter = new AuditWriter(auditLog);
    adapter = fakeAdapter();

    const executor = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => adapter,
      audit: auditWriter,
    });

    // Install a stub authMiddleware globally — the real one isn't booted in
    // this test. It injects a synthetic authenticated identity onto the
    // request. Real auth is exercised in the auth-login integration tests.
    setAuthMiddleware((req, _res, next) => {
      (req as AuthenticatedRequest).auth = identity();
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/plans', createPlansRouter({
      plans: plansRepo,
      executor,
      ac: allowAllAc,
    }));
  });

  it('autoEdit=true: GET -> approve -> all steps run -> completed + audit rows', async () => {
    const plan = await plansRepo.create(basePlan());

    // GET surfaces the plan with its steps.
    const fetched = await request(app).get(`/api/plans/${plan.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(plan.id);
    expect(fetched.body.steps).toHaveLength(2);

    // Approve with auto-edit; executor runs both steps in-process.
    const approved = await request(app)
      .post(`/api/plans/${plan.id}/approve`)
      .send({ autoEdit: true });
    expect(approved.status).toBe(200);
    expect(approved.body.outcome).toEqual({ kind: 'completed' });

    // Final state: completed + every step done + adapter called with the
    // exact argv we persisted.
    const after = await plansRepo.findByIdInOrg(ORG, plan.id);
    expect(after?.status).toBe('completed');
    expect(after?.steps.every((s) => s.status === 'done')).toBe(true);
    expect(adapter.calls.map((c) => c.argv[0])).toEqual(['scale', 'rollout']);

    // Audit is fire-and-forget; let the in-flight writes settle.
    await new Promise((r) => setTimeout(r, 10));
    // One audit_log row per step.
    const rows = await auditLog.query({ action: 'agent.plan_step', limit: 50 });
    expect(rows.items).toHaveLength(2);
    for (const r of rows.items) {
      expect(r.action).toBe('agent.plan_step');
      expect(r.outcome).toBe('success');
      expect(r.actorType).toBe('service_account');
    }
  });

  it('autoEdit=false: approve creates per-step ApprovalRequest then onStepApproved drives forward', async () => {
    const plan = await plansRepo.create(basePlan());

    const approved = await request(app)
      .post(`/api/plans/${plan.id}/approve`)
      .send({ autoEdit: false });
    expect(approved.status).toBe(200);
    expect(approved.body.outcome.kind).toBe('paused_for_approval');
    const step0ApprovalId = approved.body.outcome.approvalRequestId as string;

    // First step's approval was created.
    const a1 = await approvalsRepo.findById(step0ApprovalId);
    expect(a1?.action.type).toBe('ops.run_command');
    const ctx1 = a1?.context as { planId?: string; stepOrdinal?: number };
    expect(ctx1.planId).toBe(plan.id);
    expect(ctx1.stepOrdinal).toBe(0);

    // No execution yet — adapter wasn't called.
    expect(adapter.calls).toHaveLength(0);

    // Now resolve the approval + drive the executor (this is what the
    // approvalStore.onResolved subscription does in plans-boot).
    await approvalsRepo.approve(step0ApprovalId, 'u_2', ['operator']);
    const executor2 = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => adapter,
      audit: auditWriter,
    });
    const after1 = await executor2.onStepApproved(ORG, step0ApprovalId);
    expect(after1.kind).toBe('paused_for_approval');
    expect(adapter.calls).toHaveLength(1);

    // Approve step 2.
    if (after1.kind === 'paused_for_approval') {
      await approvalsRepo.approve(after1.approvalRequestId, 'u_2', ['operator']);
      const after2 = await executor2.onStepApproved(ORG, after1.approvalRequestId);
      expect(after2).toEqual({ kind: 'completed' });
    }
    expect(adapter.calls).toHaveLength(2);
    const final = await plansRepo.findByIdInOrg(ORG, plan.id);
    expect(final?.status).toBe('completed');
  });

  it('failure halts plan, retry-step revives it, audit logs both attempts', async () => {
    let attempt = 0;
    const flakyAdapter: FakeAdapter = fakeAdapter({
      succeed: (argv) => argv[0] === 'rollout' ? (attempt++ > 0) : true,
      error: 'rollout exited 1',
    });
    const executor = new PlanExecutorService({
      plans: plansRepo,
      adapterFor: async () => flakyAdapter,
      audit: auditWriter,
    });

    // Re-mount with this executor.
    setAuthMiddleware((req, _res, next) => {
      (req as AuthenticatedRequest).auth = identity();
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/plans', createPlansRouter({ plans: plansRepo, executor, ac: allowAllAc }));

    const plan = await plansRepo.create(basePlan());
    const r = await request(app).post(`/api/plans/${plan.id}/approve`).send({ autoEdit: true });
    expect(r.body.outcome.kind).toBe('failed');

    let after = await plansRepo.findByIdInOrg(ORG, plan.id);
    expect(after?.status).toBe('failed');
    expect(after?.steps[1]?.status).toBe('failed');

    // Retry the failed step.
    const retry = await request(app).post(`/api/plans/${plan.id}/steps/1/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toEqual({ kind: 'completed' });

    after = await plansRepo.findByIdInOrg(ORG, plan.id);
    expect(after?.status).toBe('completed');

    await new Promise((r) => setTimeout(r, 10));
    const rows = await auditLog.query({ action: 'agent.plan_step', limit: 50 });
    // step 0 success, step 1 failure, step 1 retry success = 3 rows.
    expect(rows.items.length).toBeGreaterThanOrEqual(3);
    const outcomes = rows.items.map((r) => r.outcome).sort();
    expect(outcomes).toContain('success');
    expect(outcomes).toContain('failure');
  });

  afterAll(() => {
    // Don't leave our stub middleware around for the next test file.
    setAuthMiddleware(null);
  });
});

// ---------------------------------------------------------------------------
// (B) Alert dispatcher — alert.fired wiring
// ---------------------------------------------------------------------------

describe('E2E: alert dispatcher (alert.fired -> background spawn)', () => {
  it('subscribes to alert.fired and spawns the agent with the seeded SA token + composed question', async () => {
    const events = new EventEmitter();
    const spawn = vi.fn().mockResolvedValue('investigation done');
    const d = new AutoInvestigationDispatcher({
      alertEvents: events,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
      saToken: 'openobs_sa_test',
      spawnAgent: spawn as unknown as typeof import('@agentic-obs/agent-core').runBackgroundAgent,
    });
    d.subscribe();

    const payload: AlertFiredPayload = {
      ruleId: 'r1',
      ruleName: 'high-error-rate',
      severity: 'high',
      value: 0.12,
      threshold: 0.05,
      operator: '>',
      labels: { team: 'web' },
      firedAt: '2026-04-29T00:00:00.000Z',
    };
    events.emit('alert.fired', payload);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]?.[1] as { saToken: string; message: string };
    expect(args.saToken).toBe('openobs_sa_test');
    expect(args.message).toBe(buildAlertQuestion(payload));

    // Idempotent: same ruleId fires again within the dedup window -> no
    // second spawn.
    events.emit('alert.fired', payload);
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(1);

    d.unsubscribe();
  });
});

// Quiet false-positive vi-imported lint
void vi;
