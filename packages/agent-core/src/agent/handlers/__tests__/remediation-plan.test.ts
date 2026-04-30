/**
 * Tests for the remediation_plan_create + .create_rescue handlers.
 *
 * Use the real SQLite RemediationPlan + ApprovalRequest repos so we
 * exercise the same persistence the gateway uses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterRegistry } from '../../../adapters/index.js';
import {
  createTestDb,
  SqliteRemediationPlanRepository,
  SqliteApprovalRequestRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import {
  handleRemediationPlanCreate,
  handleRemediationPlanCreateRescue,
} from '../remediation-plan.js';
import type { ActionContext } from '../_context.js';

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    gateway: {} as ActionContext['gateway'],
    model: 'test',
    store: {} as ActionContext['store'],
    investigationReportStore: {} as ActionContext['investigationReportStore'],
    alertRuleStore: {} as ActionContext['alertRuleStore'],
    adapters: new AdapterRegistry(),
    sendEvent: vi.fn(),
    sessionId: 'session-1',
    identity: { userId: 'u1', orgId: 'org_main', orgRole: 'Admin', isServerAdmin: false, authenticatedBy: 'session' },
    accessControl: {
      evaluate: async () => true,
      filterByPermission: async (_id, rows) => rows,
    },
    actionExecutor: {} as ActionContext['actionExecutor'],
    alertRuleAgent: {} as ActionContext['alertRuleAgent'],
    emitAgentEvent: vi.fn(),
    makeAgentEvent: ((type: string) => ({ type, agentType: 'orchestrator', timestamp: '' })) as ActionContext['makeAgentEvent'],
    pushConversationAction: vi.fn(),
    setNavigateTo: vi.fn(),
    investigationSections: new Map(),
    ...overrides,
  } as ActionContext;
}

const STD_CONNECTOR = {
  id: 'k8s-prod',
  name: 'k8s-prod',
  namespaces: ['app'],
  capabilities: [],
};

function validStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ops.run_command',
    commandText: 'kubectl scale deploy/web -n app --replicas=3',
    paramsJson: {
      argv: ['scale', 'deploy/web', '-n', 'app', '--replicas=3'],
      connectorId: 'k8s-prod',
    },
    ...overrides,
  };
}

describe('remediation_plan_create — error cases', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  let approvalsRepo: SqliteApprovalRequestRepository;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
    approvalsRepo = new SqliteApprovalRequestRepository(db);
  });

  it('returns Error when remediation plan store is missing', async () => {
    const ctx = makeCtx({ approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x', steps: [validStep()],
    });
    expect(r).toMatch(/^Error: remediation plan store/);
  });

  it('rejects missing investigationId / summary / steps', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    expect(await handleRemediationPlanCreate(ctx, { summary: 'x', steps: [validStep()] })).toMatch(/investigationId/);
    expect(await handleRemediationPlanCreate(ctx, { investigationId: 'inv-1', steps: [validStep()] })).toMatch(/summary/);
    expect(await handleRemediationPlanCreate(ctx, { investigationId: 'inv-1', summary: 'x' })).toMatch(/steps/);
    expect(await handleRemediationPlanCreate(ctx, { investigationId: 'inv-1', summary: 'x', steps: [] })).toMatch(/steps/);
  });

  it('rejects malformed step shape with a clear error referencing the step index', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x',
      steps: [validStep(), { kind: 'ops.run_command', commandText: 'broken' }],
    });
    expect(r).toMatch(/step\[1\]/);
  });

  it('rejects unknown step kind', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x',
      steps: [validStep({ kind: 'shell.run' })],
    });
    expect(r).toMatch(/not supported/);
  });

  it('rejects step whose connector is not configured', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [] });
    const r = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x', steps: [validStep()],
    });
    expect(r).toMatch(/connectorId 'k8s-prod' is not configured/);
  });

  it('rejects step whose argv hits the permanent-deny list (kubectl exec)', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x',
      steps: [validStep({ paramsJson: { argv: ['exec', 'web', '-n', 'app', '--', 'sh'], connectorId: 'k8s-prod' } })],
    });
    expect(r).toMatch(/permanently denied/);
  });

  it('rejects step targeting a namespace outside the connector allowlist', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x',
      steps: [validStep({ paramsJson: { argv: ['scale', 'deploy/web', '-n', 'kube-system', '--replicas=3'], connectorId: 'k8s-prod' } })],
    });
    expect(r).toMatch(/permanently denied|not in the connector/);
  });

  it('does not half-persist when one step is bad', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x',
      steps: [validStep(), validStep({ paramsJson: { argv: ['exec', 'web', '-n', 'app'], connectorId: 'k8s-prod' } })],
    });
    const list = await plansRepo.listByOrg('org_main');
    expect(list).toHaveLength(0);
  });
});

describe('remediation_plan_create — happy path', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  let approvalsRepo: SqliteApprovalRequestRepository;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
    approvalsRepo = new SqliteApprovalRequestRepository(db);
  });

  it('persists plan + steps + an ApprovalRequest, all linked', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const observation = await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1',
      summary: 'Scale web',
      steps: [
        validStep(),
        validStep({
          commandText: 'kubectl rollout status deploy/web -n app',
          paramsJson: { argv: ['rollout', 'status', 'deploy/web', '-n', 'app'], connectorId: 'k8s-prod' },
        }),
      ],
    });
    expect(observation).toMatch(/Created remediation plan/);
    expect(observation).toMatch(/2 steps/);

    const plans = await plansRepo.listByOrg('org_main');
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.status).toBe('pending_approval');
    expect(plan.investigationId).toBe('inv-1');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.ordinal).toBe(0);
    expect(plan.steps[1]?.ordinal).toBe(1);
    expect(plan.approvalRequestId).toBeTruthy();

    const approval = await approvalsRepo.findById(plan.approvalRequestId!);
    expect(approval?.action.type).toBe('plan');
    expect((approval?.context as { planId?: string }).planId).toBe(plan.id);
  });

  it('honors expiresInMs', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const before = Date.now();
    await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x', steps: [validStep()],
      expiresInMs: 60_000,
    });
    const plan = (await plansRepo.listByOrg('org_main'))[0]!;
    const expiresMs = new Date(plan.expiresAt).getTime();
    expect(expiresMs - before).toBeGreaterThanOrEqual(50_000);
    expect(expiresMs - before).toBeLessThanOrEqual(80_000);
  });

  it('persists riskNote, dryRunText, continueOnError on individual steps', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x',
      steps: [validStep({
        riskNote: 'pods will restart',
        dryRunText: '+1 replica',
        continueOnError: true,
      })],
    });
    const plan = (await plansRepo.listByOrg('org_main'))[0]!;
    expect(plan.steps[0]?.riskNote).toBe('pods will restart');
    expect(plan.steps[0]?.dryRunText).toBe('+1 replica');
    expect(plan.steps[0]?.continueOnError).toBe(true);
  });

  it('persists plan even when approvalRequests is unset (no auto-approval)', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, opsConnectors: [STD_CONNECTOR] });
    await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'x', steps: [validStep()],
    });
    const plan = (await plansRepo.listByOrg('org_main'))[0]!;
    expect(plan.status).toBe('pending_approval');
    expect(plan.approvalRequestId).toBeNull();
  });
});

describe('remediation_plan_create_rescue', () => {
  let db: SqliteClient;
  let plansRepo: SqliteRemediationPlanRepository;
  let approvalsRepo: SqliteApprovalRequestRepository;

  beforeEach(() => {
    db = createTestDb();
    plansRepo = new SqliteRemediationPlanRepository(db);
    approvalsRepo = new SqliteApprovalRequestRepository(db);
  });

  it('requires rescueForPlanId', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreateRescue(ctx, {
      investigationId: 'inv-1', summary: 'x', steps: [validStep()],
    });
    expect(r).toMatch(/rescueForPlanId/);
  });

  it('rejects when parent plan does not exist', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    const r = await handleRemediationPlanCreateRescue(ctx, {
      investigationId: 'inv-1', summary: 'x', steps: [validStep()],
      rescueForPlanId: 'plan-missing',
    });
    expect(r).toMatch(/parent plan.*not found/);
  });

  it('persists rescue plan but does NOT create an ApprovalRequest', async () => {
    const ctx = makeCtx({ remediationPlans: plansRepo, approvalRequests: approvalsRepo, opsConnectors: [STD_CONNECTOR] });
    // 1) primary plan
    await handleRemediationPlanCreate(ctx, {
      investigationId: 'inv-1', summary: 'primary', steps: [validStep()],
    });
    const primary = (await plansRepo.listByOrg('org_main'))[0]!;

    // 2) rescue
    const observation = await handleRemediationPlanCreateRescue(ctx, {
      investigationId: 'inv-1',
      summary: 'rollback',
      rescueForPlanId: primary.id,
      steps: [validStep({
        commandText: 'kubectl scale deploy/web -n app --replicas=1',
        paramsJson: { argv: ['scale', 'deploy/web', '-n', 'app', '--replicas=1'], connectorId: 'k8s-prod' },
      })],
    });
    expect(observation).toMatch(/Created rescue plan/);
    expect(observation).toMatch(/operator triggers it from the UI/);

    const all = await plansRepo.listByOrg('org_main');
    expect(all).toHaveLength(2);
    const rescue = all.find((p) => p.rescueForPlanId === primary.id)!;
    expect(rescue.status).toBe('pending_approval');
    expect(rescue.approvalRequestId).toBeNull();
  });
});
