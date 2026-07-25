import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-support/test-db.js';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { SqliteRemediationPlanRepository } from './remediation-plan.js';
import type { NewRemediationPlan } from '../types/remediation-plan.js';

function basePlan(overrides: Partial<NewRemediationPlan> = {}): NewRemediationPlan {
  return {
    orgId: 'org_main',
    investigationId: 'inv-1',
    summary: 'Scale web up',
    createdBy: 'agent',
    steps: [
      {
        kind: 'ops.run_command',
        commandText: 'kubectl scale deploy web -n app --replicas=3',
        paramsJson: { verb: 'scale', namespace: 'app' },
        riskNote: 'mid risk',
      },
      {
        kind: 'ops.run_command',
        commandText: 'kubectl rollout status deploy/web -n app',
        paramsJson: { verb: 'rollout', namespace: 'app' },
      },
    ],
    ...overrides,
  };
}

describe('SqliteRemediationPlanRepository', () => {
  let db: SqliteClient;
  let repo: SqliteRemediationPlanRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteRemediationPlanRepository(db);
  });

  it('creates a plan with steps and assigns ordinals + defaults', async () => {
    const plan = await repo.create(basePlan());
    expect(plan.id).toMatch(/^plan-/);
    expect(plan.status).toBe('pending_approval');
    expect(plan.linkedAlertRuleId).toBeNull();
    expect(plan.targetObject).toBeNull();
    expect(plan.validationMethod).toBeNull();
    expect(plan.verificationStatus).toBe('not_started');
    expect(plan.verificationStartedAt).toBeNull();
    expect(plan.verificationDeadlineAt).toBeNull();
    expect(plan.verificationEvidenceJson).toBeNull();
    expect(plan.continuationInvestigationId).toBeNull();
    expect(plan.autoEdit).toBe(false);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.ordinal).toBe(0);
    expect(plan.steps[1]?.ordinal).toBe(1);
    expect(plan.steps[0]?.status).toBe('pending');
    expect(plan.steps[0]?.continueOnError).toBe(false);
    expect(plan.steps[0]?.paramsJson).toEqual({ verb: 'scale', namespace: 'app' });
    expect(plan.steps[0]?.riskNote).toBe('mid risk');
    expect(plan.expiresAt > plan.createdAt).toBe(true);
  });

  it('respects supplied id, expiresAt, autoEdit, and rescueForPlanId', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const plan = await repo.create(
      basePlan({
        id: 'plan-explicit',
        expiresAt,
        autoEdit: true,
        rescueForPlanId: 'plan-other',
      }),
    );
    expect(plan.id).toBe('plan-explicit');
    expect(plan.expiresAt).toBe(expiresAt);
    expect(plan.autoEdit).toBe(true);
    expect(plan.rescueForPlanId).toBe('plan-other');
  });

  it('findByIdInOrg returns null cross-org and null for missing ids', async () => {
    const plan = await repo.create(basePlan({ orgId: 'org_a' }));
    expect(await repo.findByIdInOrg('org_a', plan.id)).not.toBeNull();
    expect(await repo.findByIdInOrg('org_b', plan.id)).toBeNull();
    expect(await repo.findByIdInOrg('org_a', 'plan-missing')).toBeNull();
  });

  it('findById and findByApprovalRequestId support cross-org approval resume', async () => {
    const plan = await repo.create(basePlan({
      orgId: 'org_resume',
      approvalRequestId: 'approval-plan',
    }));
    await repo.updateStep(plan.id, 1, { approvalRequestId: 'approval-step' });

    expect((await repo.findById(plan.id))?.orgId).toBe('org_resume');
    expect((await repo.findByApprovalRequestId('approval-plan'))?.id).toBe(plan.id);
    expect((await repo.findByApprovalRequestId('approval-step'))?.id).toBe(plan.id);
    expect(await repo.findByApprovalRequestId('approval-missing')).toBeNull();
  });

  it('listByOrg filters by status, investigationId, rescueForPlanId', async () => {
    const a = await repo.create(basePlan({ summary: 'a', investigationId: 'inv-1' }));
    const b = await repo.create(basePlan({ summary: 'b', investigationId: 'inv-2' }));
    await repo.updatePlan('org_main', b.id, { status: 'approved' });
    const c = await repo.create(
      basePlan({ summary: 'c-rescue', investigationId: 'inv-1', rescueForPlanId: a.id }),
    );

    const pending = await repo.listByOrg('org_main', { status: 'pending_approval' });
    expect(pending.map((p) => p.id).sort()).toEqual([a.id, c.id].sort());

    const byInv2 = await repo.listByOrg('org_main', { investigationId: 'inv-2' });
    expect(byInv2.map((p) => p.id)).toEqual([b.id]);

    const onlyRescues = await repo.listByOrg('org_main', { rescueForPlanId: a.id });
    expect(onlyRescues.map((p) => p.id)).toEqual([c.id]);

    const nonRescues = await repo.listByOrg('org_main', { rescueForPlanId: null });
    expect(nonRescues.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('updatePlan changes status + autoEdit + resolved fields', async () => {
    const plan = await repo.create(basePlan());
    const after = await repo.updatePlan('org_main', plan.id, {
      status: 'approved',
      autoEdit: true,
      resolvedAt: '2026-04-29T00:00:00.000Z',
      resolvedBy: 'user-1',
    });
    expect(after?.status).toBe('approved');
    expect(after?.autoEdit).toBe(true);
    expect(after?.resolvedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(after?.resolvedBy).toBe('user-1');
  });

  it('persists and filters verification metadata', async () => {
    const plan = await repo.create(basePlan({
      linkedAlertRuleId: 'alert-1',
      targetObject: 'deployment/web',
      validationMethod: 'linked_alert_rule',
    }));
    expect(plan.linkedAlertRuleId).toBe('alert-1');
    expect(plan.targetObject).toBe('deployment/web');
    expect(plan.validationMethod).toBe('linked_alert_rule');

    const after = await repo.updatePlan('org_main', plan.id, {
      status: 'applied',
      verificationStatus: 'waiting',
      verificationStartedAt: '2026-04-29T00:00:00.000Z',
      verificationDeadlineAt: '2026-04-29T00:01:00.000Z',
      verificationEvidenceJson: { reason: 'waiting' },
    });
    expect(after?.status).toBe('applied');
    expect(after?.verificationStatus).toBe('waiting');
    expect(after?.verificationEvidenceJson).toEqual({ reason: 'waiting' });

    const waiting = await repo.listWaitingVerification();
    expect(waiting.map((p) => p.id)).toEqual([plan.id]);

    const filtered = await repo.listByOrg('org_main', { verificationStatus: 'waiting' });
    expect(filtered.map((p) => p.id)).toEqual([plan.id]);
  });

  it('listAppliedAwaitingVerification finds only applied plans with verification not started', async () => {
    const stranded = await repo.create(basePlan({ linkedAlertRuleId: 'alert-1' }));
    await repo.updatePlan('org_main', stranded.id, { status: 'applied' });

    const verifying = await repo.create(basePlan({ linkedAlertRuleId: 'alert-1' }));
    await repo.updatePlan('org_main', verifying.id, {
      status: 'applied',
      verificationStatus: 'waiting',
    });

    // Still executing — verification is legitimately not started yet.
    const executing = await repo.create(basePlan({ linkedAlertRuleId: 'alert-1' }));
    await repo.updatePlan('org_main', executing.id, { status: 'executing' });

    const found = await repo.listAppliedAwaitingVerification();
    expect(found.map((p) => p.id)).toEqual([stranded.id]);
    expect(found[0]?.steps).toHaveLength(stranded.steps.length);
  });

  it('updatePlan cross-org returns null and writes nothing', async () => {
    const plan = await repo.create(basePlan({ orgId: 'org_a' }));
    const result = await repo.updatePlan('org_b', plan.id, { status: 'approved' });
    expect(result).toBeNull();
    const reread = await repo.findByIdInOrg('org_a', plan.id);
    expect(reread?.status).toBe('pending_approval');
  });

  it('updateStep updates only the targeted step', async () => {
    const plan = await repo.create(basePlan());
    const updated = await repo.updateStep(plan.id, 1, {
      status: 'done',
      executedAt: '2026-04-29T00:01:00.000Z',
      outputText: 'rollout complete',
    });
    expect(updated?.status).toBe('done');
    expect(updated?.executedAt).toBe('2026-04-29T00:01:00.000Z');

    const reread = await repo.findByIdInOrg('org_main', plan.id);
    expect(reread?.steps[0]?.status).toBe('pending');
    expect(reread?.steps[1]?.status).toBe('done');
    expect(reread?.steps[1]?.outputText).toBe('rollout complete');
  });

  it('updateStep returns null for unknown step ordinals', async () => {
    const plan = await repo.create(basePlan());
    const result = await repo.updateStep(plan.id, 99, { status: 'done' });
    expect(result).toBeNull();
  });

  it('delete removes plan and steps; cross-org delete is a no-op', async () => {
    const plan = await repo.create(basePlan({ orgId: 'org_a' }));
    expect(await repo.delete('org_b', plan.id)).toBe(false);
    expect(await repo.findByIdInOrg('org_a', plan.id)).not.toBeNull();
    expect(await repo.delete('org_a', plan.id)).toBe(true);
    expect(await repo.findByIdInOrg('org_a', plan.id)).toBeNull();
  });

  it('expireStale flips only pending_approval rows past expires_at', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const stale = await repo.create(basePlan({ summary: 'stale', expiresAt: past }));
    const fresh = await repo.create(basePlan({ summary: 'fresh', expiresAt: future }));
    const approved = await repo.create(basePlan({ summary: 'approved', expiresAt: past }));
    await repo.updatePlan('org_main', approved.id, { status: 'approved' });

    const now = new Date().toISOString();
    expect(await repo.expireStale(now)).toBe(1);

    expect((await repo.findByIdInOrg('org_main', stale.id))?.status).toBe('expired');
    expect((await repo.findByIdInOrg('org_main', fresh.id))?.status).toBe('pending_approval');
    expect((await repo.findByIdInOrg('org_main', approved.id))?.status).toBe('approved');
  });
});
