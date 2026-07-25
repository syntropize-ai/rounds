import { beforeEach, describe, expect, it } from 'vitest';
import type { AlertRule } from '@agentic-obs/common';
import { createTestDb } from '../../../data-layer/src/test-support/test-db.js';
import type { SqliteClient } from '../../../data-layer/src/db/sqlite-client.js';
import { SqliteRemediationPlanRepository } from '../../../data-layer/src/repository/sqlite/remediation-plan.js';
import type { NewRemediationPlan } from '../../../data-layer/src/repository/types/remediation-plan.js';
import { PlanVerificationService } from './plan-verification-service.js';

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
        paramsJson: { argv: ['scale', 'deploy', 'web', '-n', 'app', '--replicas=3'], connectorId: 'k8s-prod' },
      },
    ],
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'alert-1',
    name: 'Web down',
    description: '',
    condition: { query: 'up', operator: '<', threshold: 1, forDurationSec: 0 },
    evaluationIntervalSec: 10,
    severity: 'high',
    state: 'firing',
    stateChangedAt: '2026-04-29T00:00:00.000Z',
    createdBy: 'u1',
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    fireCount: 1,
    ...overrides,
  };
}

describe('PlanVerificationService', () => {
  let db: SqliteClient;
  let plans: SqliteRemediationPlanRepository;
  let nowMs: number;
  let currentRule: AlertRule | undefined;

  beforeEach(() => {
    db = createTestDb();
    plans = new SqliteRemediationPlanRepository(db);
    nowMs = Date.parse('2026-04-29T00:00:00.000Z');
    currentRule = rule();
  });

  function service(): PlanVerificationService {
    return new PlanVerificationService({
      plans,
      alertRules: { findById: async (id) => (id === currentRule?.id ? currentRule : undefined) },
      floorMs: 30_000,
      now: () => new Date(nowMs),
    });
  }

  it('skips verification when no linked alert rule exists', async () => {
    const plan = await plans.create(basePlan({ status: 'applied' }));
    const after = await service().beginVerification(plan);
    expect(after?.status).toBe('applied');
    expect(after?.verificationStatus).toBe('skipped');
    expect(after?.verificationEvidenceJson?.['reason']).toBe('no linked alert rule');
  });

  it('starts waiting with a required deadline when linked alert exists', async () => {
    const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
    const after = await service().beginVerification(plan);
    expect(after?.verificationStatus).toBe('waiting');
    expect(after?.verificationStartedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(after?.verificationDeadlineAt).toBe('2026-04-29T00:00:30.000Z');
    expect(after?.verificationEvidenceJson?.['waitMs']).toBe(30_000);
  });

  it('passes when the linked rule evaluates normal after verification started', async () => {
    const svc = service();
    const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
    await svc.beginVerification(plan);

    nowMs = Date.parse('2026-04-29T00:00:12.000Z');
    currentRule = rule({ state: 'normal', lastEvaluatedAt: '2026-04-29T00:00:12.000Z' });
    expect(await svc.sweep()).toBe(1);
    const after = await plans.findByIdInOrg('org_main', plan.id);
    expect(after?.verificationStatus).toBe('passed');
  });

  it('fails at deadline when the linked rule is freshly still firing', async () => {
    const svc = service();
    const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
    await svc.beginVerification(plan);

    nowMs = Date.parse('2026-04-29T00:00:31.000Z');
    currentRule = rule({ state: 'firing', lastEvaluatedAt: '2026-04-29T00:00:31.000Z' });
    expect(await svc.sweep()).toBe(1);
    const after = await plans.findByIdInOrg('org_main', plan.id);
    expect(after?.verificationStatus).toBe('failed');
  });

  describe('recoverInterrupted', () => {
    it('resumes a plan persisted as applied with verification never started', async () => {
      // The executor's `status='applied'` write landed; the process died before
      // the verifier wrote `verificationStatus='waiting'`.
      const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
      expect(plan.verificationStatus).toBe('not_started');

      expect(await service().recoverInterrupted()).toBe(1);

      const after = await plans.findByIdInOrg('org_main', plan.id);
      expect(after?.verificationStatus).toBe('waiting');
      expect(after?.verificationStartedAt).toBe('2026-04-29T00:00:00.000Z');
      expect(after?.verificationDeadlineAt).toBe('2026-04-29T00:00:30.000Z');
    });

    it('resolves a stranded plan that has no linked alert rule to verify', async () => {
      const plan = await plans.create(basePlan({ status: 'applied' }));

      expect(await service().recoverInterrupted()).toBe(1);

      const after = await plans.findByIdInOrg('org_main', plan.id);
      expect(after?.verificationStatus).toBe('skipped');
    });

    it('finalizes a waiting plan whose deadline passed while the process was down', async () => {
      const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
      await service().beginVerification(plan);

      // Restart: the in-memory timer is gone and the deadline is long past.
      nowMs = Date.parse('2026-04-29T00:05:00.000Z');
      currentRule = rule({ state: 'firing', lastEvaluatedAt: '2026-04-29T00:04:50.000Z' });
      expect(await service().recoverInterrupted()).toBe(1);

      const after = await plans.findByIdInOrg('org_main', plan.id);
      expect(after?.verificationStatus).toBe('failed');
    });

    it('leaves a healthy in-flight verification untouched', async () => {
      const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
      const started = await service().beginVerification(plan);

      nowMs = Date.parse('2026-04-29T00:00:05.000Z');
      expect(await service().recoverInterrupted()).toBe(0);

      const after = await plans.findByIdInOrg('org_main', plan.id);
      expect(after?.verificationStatus).toBe('waiting');
      expect(after?.verificationDeadlineAt).toBe(started?.verificationDeadlineAt);
      expect(after?.verificationStartedAt).toBe(started?.verificationStartedAt);
    });
  });

  it('marks inconclusive at deadline when the evaluator never ran after start', async () => {
    const svc = service();
    const plan = await plans.create(basePlan({ status: 'applied', linkedAlertRuleId: 'alert-1' }));
    await svc.beginVerification(plan);

    nowMs = Date.parse('2026-04-29T00:00:31.000Z');
    currentRule = rule({ state: 'normal', lastEvaluatedAt: '2026-04-28T23:59:59.000Z' });
    expect(await svc.sweep()).toBe(1);
    const after = await plans.findByIdInOrg('org_main', plan.id);
    expect(after?.verificationStatus).toBe('inconclusive');
  });
});
