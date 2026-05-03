/**
 * PlanExecutorService unit tests. Use the real SQLite RemediationPlan repo
 * + an injected fake adapter so we can drive happy paths and failure paths
 * without spawning kubectl.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, SqliteRemediationPlanRepository, SqliteApprovalRequestRepository } from '@agentic-obs/data-layer';
import type { SqliteClient, NewRemediationPlan } from '@agentic-obs/data-layer';
import type { ExecutionAdapter } from '@agentic-obs/adapters';
import type { Identity } from '@agentic-obs/common';
import { PlanExecutorService } from './plan-executor-service.js';

const ID: Identity = {
  userId: 'user-1',
  orgId: 'org_main',
  orgRole: 'Editor',
  isServerAdmin: false,
  authenticatedBy: 'password',
};

function basePlan(overrides: Partial<NewRemediationPlan> = {}): NewRemediationPlan {
  return {
    orgId: 'org_main',
    investigationId: 'inv-1',
    summary: 'Scale + verify',
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
    ...overrides,
  };
}

interface FakeAdapter extends ExecutionAdapter {
  calls: ReadonlyArray<{ argv: string[] }>;
}

function fakeAdapter(opts: {
  succeed?: boolean | ((argv: string[]) => boolean);
  output?: string;
  error?: string;
} = {}): FakeAdapter {
  const calls: Array<{ argv: string[] }> = [];
  const succeedDefault = opts.succeed ?? true;
  return {
    capabilities: () => ['k8s.read', 'k8s.write'],
    async validate() { return { valid: true }; },
    async dryRun() { return { estimatedImpact: 'ok', warnings: [], willAffect: [] }; },
    async execute(action) {
      const argv = (action.params as { argv?: string[] }).argv ?? [];
      calls.push({ argv: [...argv] });
      const ok = typeof succeedDefault === 'function' ? succeedDefault(argv) : succeedDefault;
      return ok
        ? { success: true, output: opts.output ?? 'ok', rollbackable: false, executionId: 'x' }
        : { success: false, output: '', rollbackable: false, executionId: 'x', error: opts.error ?? 'failed' };
    },
    get calls() { return calls; },
  };
}

describe('PlanExecutorService — autoEdit happy path', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
  });

  it('runs every step and marks the plan completed', async () => {
    const plan = await plansRepo.create(basePlan());
    const adapter = fakeAdapter();
    const svc = new PlanExecutorService({
      plans: plansRepo,
      adapterFor: async () => adapter,
    });
    const outcome = await svc.approve('org_main', plan.id, true, ID);
    expect(outcome).toEqual({ kind: 'completed' });
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.status).toBe('completed');
    expect(fresh?.steps.every((s) => s.status === 'done')).toBe(true);
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.argv[0]).toBe('scale');
    expect(adapter.calls[1]?.argv[0]).toBe('rollout');
  });

  it('halts on step failure; subsequent steps are skipped', async () => {
    const plan = await plansRepo.create(basePlan());
    const adapter = fakeAdapter({
      succeed: (argv) => argv[0] !== 'rollout',
      error: 'rollout exited 1',
    });
    const svc = new PlanExecutorService({
      plans: plansRepo,
      adapterFor: async () => adapter,
    });
    const outcome = await svc.approve('org_main', plan.id, true, ID);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failedOrdinal).toBe(1);
      expect(outcome.reason).toMatch(/rollout exited 1/);
    }
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.status).toBe('failed');
    expect(fresh?.steps[0]?.status).toBe('done');
    expect(fresh?.steps[1]?.status).toBe('failed');
  });

  it('continueOnError lets later steps still run after a failure', async () => {
    const plan = await plansRepo.create(basePlan({
      steps: [
        {
          kind: 'ops.run_command',
          commandText: 'kubectl get pods -n app',
          paramsJson: { argv: ['get', 'pods', '-n', 'app'], connectorId: 'k8s-prod' },
          continueOnError: true,
        },
        {
          kind: 'ops.run_command',
          commandText: 'kubectl rollout status deploy/web -n app',
          paramsJson: { argv: ['rollout', 'status', 'deploy/web', '-n', 'app'], connectorId: 'k8s-prod' },
        },
      ],
    }));
    const adapter = fakeAdapter({
      succeed: (argv) => argv[0] === 'rollout', // first fails, second succeeds
    });
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => adapter });
    const outcome = await svc.approve('org_main', plan.id, true, ID);
    expect(outcome).toEqual({ kind: 'completed' });
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.steps[0]?.status).toBe('failed');
    expect(fresh?.steps[1]?.status).toBe('done');
    expect(fresh?.status).toBe('completed');
  });

  it('rejects approve on non-pending_approval plan', async () => {
    const plan = await plansRepo.create(basePlan({ status: 'approved' }));
    const adapter = fakeAdapter();
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => adapter });
    await expect(svc.approve('org_main', plan.id, true, ID)).rejects.toThrow(/cannot approve/);
  });

  it('truncates large outputs to 64 KB', async () => {
    const big = 'X'.repeat(70_000);
    const plan = await plansRepo.create(basePlan());
    const adapter = fakeAdapter({ output: big });
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => adapter });
    await svc.approve('org_main', plan.id, true, ID);
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.steps[0]?.outputText?.length).toBe(64 * 1024);
  });
});

describe('PlanExecutorService — autoEdit=false (per-step approval)', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  let approvalsRepo: SqliteApprovalRequestRepository;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
    approvalsRepo = new SqliteApprovalRequestRepository(db);
  });

  it('approving a non-autoEdit plan creates the first step ApprovalRequest and pauses', async () => {
    const plan = await plansRepo.create(basePlan());
    const adapter = fakeAdapter();
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => adapter,
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    expect(outcome.kind).toBe('paused_for_approval');
    if (outcome.kind === 'paused_for_approval') {
      expect(outcome.stepOrdinal).toBe(0);
      const approval = await approvalsRepo.findById(outcome.approvalRequestId);
      expect(approval?.action.type).toBe('ops.run_command');
      const ctx = approval?.context as { planId?: string; stepOrdinal?: number };
      expect(ctx.planId).toBe(plan.id);
      expect(ctx.stepOrdinal).toBe(0);
    }
    expect(adapter.calls).toHaveLength(0);
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.status).toBe('executing');
    expect(fresh?.steps[0]?.approvalRequestId).toBeTruthy();
  });

  it('onStepApproved runs the gated step and pauses for the next', async () => {
    const plan = await plansRepo.create(basePlan());
    const adapter = fakeAdapter();
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => adapter,
    });
    const first = await svc.approve('org_main', plan.id, false, ID);
    if (first.kind !== 'paused_for_approval') throw new Error('expected paused');
    await approvalsRepo.approve(first.approvalRequestId, 'user-1', ['operator']);
    const after1 = await svc.onStepApproved('org_main', first.approvalRequestId);
    expect(after1.kind).toBe('paused_for_approval');
    expect(adapter.calls).toHaveLength(1);

    if (after1.kind === 'paused_for_approval') {
      await approvalsRepo.approve(after1.approvalRequestId, 'user-1', ['operator']);
      const after2 = await svc.onStepApproved('org_main', after1.approvalRequestId);
      expect(after2).toEqual({ kind: 'completed' });
    }
    expect(adapter.calls).toHaveLength(2);
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.status).toBe('completed');
  });

  it('onStepRejected halts the plan unless continueOnError is set', async () => {
    const plan = await plansRepo.create(basePlan());
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
    });
    const first = await svc.approve('org_main', plan.id, false, ID);
    if (first.kind !== 'paused_for_approval') throw new Error('expected paused');
    await approvalsRepo.reject(first.approvalRequestId, 'user-1', ['operator']);
    const after = await svc.onStepRejected('org_main', first.approvalRequestId);
    expect(after.kind).toBe('failed');
    const fresh = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(fresh?.status).toBe('failed');
    expect(fresh?.steps[1]?.status).toBe('skipped');
  });
});

describe('PlanExecutorService — reject / cancel', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
  });

  it('reject from pending_approval is permanent', async () => {
    const plan = await plansRepo.create(basePlan());
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => fakeAdapter() });
    const after = await svc.reject('org_main', plan.id, ID);
    expect(after?.status).toBe('rejected');
    expect(after?.resolvedBy).toBe('user-1');
  });

  it('cancel from approved/executing is permitted', async () => {
    const plan = await plansRepo.create(basePlan({ status: 'approved' }));
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => fakeAdapter() });
    const after = await svc.cancel('org_main', plan.id, ID);
    expect(after?.status).toBe('cancelled');
  });

  it('cancel from completed throws', async () => {
    const plan = await plansRepo.create(basePlan({ status: 'completed' }));
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => fakeAdapter() });
    await expect(svc.cancel('org_main', plan.id, ID)).rejects.toThrow(/cannot cancel/);
  });
});

describe('PlanExecutorService — retryStep', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
  });

  it('retries a single failed step and continues; plan goes from failed → completed', async () => {
    const plan = await plansRepo.create(basePlan());
    const succeedSecondTry = (() => {
      let called = 0;
      return () => { called++; return called > 2; }; // fail on first 2 calls (only the failing step)
    })();
    const adapter = fakeAdapter({ succeed: (argv) => argv[0] === 'rollout' ? succeedSecondTry() : true });
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => adapter });
    const first = await svc.approve('org_main', plan.id, true, ID);
    expect(first.kind).toBe('failed');
    let snapshot = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.steps[1]?.status).toBe('failed');

    // First retry: still fails (succeedSecondTry returns false on call #2)
    const retry1 = await svc.retryStep('org_main', plan.id, 1);
    expect(retry1.kind).toBe('failed');

    // Second retry: succeeds
    const retry2 = await svc.retryStep('org_main', plan.id, 1);
    expect(retry2).toEqual({ kind: 'completed' });
    snapshot = await plansRepo.findByIdInOrg('org_main', plan.id);
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.steps[1]?.status).toBe('done');
  });

  it('refuses to retry a non-failed step', async () => {
    const plan = await plansRepo.create(basePlan());
    const svc = new PlanExecutorService({ plans: plansRepo, adapterFor: async () => fakeAdapter() });
    await expect(svc.retryStep('org_main', plan.id, 0)).rejects.toThrow(/only failed steps/);
  });
});


describe('PlanExecutorService — audit hook', () => {
  it('emits one audit row per step on success and failure', async () => {
    const db = createTestDb();
    const repo = new SqliteRemediationPlanRepository(db);
    const calls: Array<{ outcome: string; metadata: Record<string, unknown> }> = [];
    const audit = {
      log: async (entry: { outcome: string; metadata: unknown }) => {
        calls.push({ outcome: entry.outcome, metadata: (entry.metadata ?? {}) as Record<string, unknown> });
      },
    } as unknown as import('../auth/audit-writer.js').AuditWriter;

    const plan = await repo.create(basePlan());
    const adapter = fakeAdapter({ succeed: (argv) => argv[0] !== 'rollout' });
    const svc = new PlanExecutorService({
      plans: repo,
      adapterFor: async () => adapter,
      audit,
    });
    await svc.approve('org_main', plan.id, true, ID);
    // step 0: scale -> ok; step 1: rollout -> fail
    expect(calls).toHaveLength(2);
    expect(calls[0]?.outcome).toBe('success');
    expect(calls[0]?.metadata['verb']).toBe('scale');
    expect(calls[1]?.outcome).toBe('failure');
    expect(calls[1]?.metadata['verb']).toBe('rollout');
  });
});

/**
 * T2.1 acceptance — when plan-executor creates a per-step ApprovalRequest it
 * stamps the row with `ops_connector_id`, `target_namespace`, and
 * `requester_team_id`, deriving them from the step's argv and the injected
 * team resolver. NULL semantics per approvals-multi-team-scope §3.2 / §3.6.
 */
describe('PlanExecutorService — approval-row scope enrichment', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  let approvalsRepo: SqliteApprovalRequestRepository;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
    approvalsRepo = new SqliteApprovalRequestRepository(db);
  });

  it('happy path: namespaced ops step + team-owned alert rule → all 3 fields populated', async () => {
    const plan = await plansRepo.create(basePlan());
    const resolveRequesterTeamId = vi.fn().mockResolvedValue('t-platform');
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
      resolveRequesterTeamId,
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    if (outcome.kind !== 'paused_for_approval') throw new Error('expected paused');
    const approval = await approvalsRepo.findById(outcome.approvalRequestId);
    expect(approval?.opsConnectorId).toBe('k8s-prod');
    expect(approval?.targetNamespace).toBe('app');
    expect(approval?.requesterTeamId).toBe('t-platform');
    expect(resolveRequesterTeamId).toHaveBeenCalledWith('org_main', 'inv-1');
  });

  it('cluster-scoped step (no -n flag): connector set, namespace NULL', async () => {
    const plan = await plansRepo.create(
      basePlan({
        steps: [
          {
            kind: 'ops.run_command',
            commandText: 'kubectl get nodes',
            paramsJson: { argv: ['get', 'nodes'], connectorId: 'k8s-prod' },
          },
        ],
      }),
    );
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
      resolveRequesterTeamId: async () => 't-platform',
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    if (outcome.kind !== 'paused_for_approval') throw new Error('expected paused');
    const approval = await approvalsRepo.findById(outcome.approvalRequestId);
    expect(approval?.opsConnectorId).toBe('k8s-prod');
    expect(approval?.targetNamespace).toBeNull();
    expect(approval?.requesterTeamId).toBe('t-platform');
  });

  it('non-ops step kind: both connector + namespace are NULL', async () => {
    const plan = await plansRepo.create(
      basePlan({
        steps: [
          {
            kind: 'alert_rule_write',
            commandText: 'pause noisy alert rule',
            paramsJson: { ruleId: 'rule-1', state: 'paused' },
          },
        ],
      }),
    );
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
      resolveRequesterTeamId: async () => 't-platform',
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    if (outcome.kind !== 'paused_for_approval') throw new Error('expected paused');
    const approval = await approvalsRepo.findById(outcome.approvalRequestId);
    expect(approval?.opsConnectorId).toBeNull();
    expect(approval?.targetNamespace).toBeNull();
    expect(approval?.requesterTeamId).toBe('t-platform');
  });

  it('chat-driven investigation (no alert rule): requester_team_id is NULL', async () => {
    const plan = await plansRepo.create(basePlan());
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
      // resolver returns NULL when investigation isn't linked to a rule.
      resolveRequesterTeamId: async () => null,
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    if (outcome.kind !== 'paused_for_approval') throw new Error('expected paused');
    const approval = await approvalsRepo.findById(outcome.approvalRequestId);
    expect(approval?.opsConnectorId).toBe('k8s-prod');
    expect(approval?.targetNamespace).toBe('app');
    expect(approval?.requesterTeamId).toBeNull();
  });

  it('alert rule in folder without team binding: requester_team_id is NULL', async () => {
    // Identical to the previous case from the executor's perspective — the
    // resolver folds "no rule", "rule with no folder", and "folder with no
    // team binding" all into a single `null` return. Pinning this case
    // separately so a future refactor that introduces a sentinel (e.g.
    // 'unknown') for the no-team-binding case fails loudly.
    const plan = await plansRepo.create(basePlan());
    const resolveRequesterTeamId = vi.fn().mockResolvedValue(null);
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
      resolveRequesterTeamId,
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    if (outcome.kind !== 'paused_for_approval') throw new Error('expected paused');
    const approval = await approvalsRepo.findById(outcome.approvalRequestId);
    expect(approval?.requesterTeamId).toBeNull();
    expect(resolveRequesterTeamId).toHaveBeenCalledTimes(1);
  });

  it('no resolver wired: requester_team_id is NULL (back-compat)', async () => {
    const plan = await plansRepo.create(basePlan());
    const svc = new PlanExecutorService({
      plans: plansRepo,
      approvals: approvalsRepo,
      adapterFor: async () => fakeAdapter(),
      // resolveRequesterTeamId omitted entirely.
    });
    const outcome = await svc.approve('org_main', plan.id, false, ID);
    if (outcome.kind !== 'paused_for_approval') throw new Error('expected paused');
    const approval = await approvalsRepo.findById(outcome.approvalRequestId);
    expect(approval?.requesterTeamId).toBeNull();
  });
});
