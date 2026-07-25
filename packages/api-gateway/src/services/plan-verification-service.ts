import { createLogger } from '@agentic-obs/server-utils/logging';
import type { AlertRule } from '@agentic-obs/common';
import type {
  IAlertRuleRepository,
  IRemediationPlanRepository,
  RemediationPlan,
  RemediationPlanVerificationStatus,
} from '@agentic-obs/data-layer';

const log = createLogger('plan-verification');

export interface PlanVerificationServiceOptions {
  plans: IRemediationPlanRepository;
  alertRules: Pick<IAlertRuleRepository, 'findById'>;
  floorMs?: number;
  sweepIntervalMs?: number;
  now?: () => Date;
}

type VerificationEvidence = Record<string, unknown> & {
  reason: string;
  checkedAt: string;
  targetObject: string | null;
  validationMethod: string | null;
  linkedAlertRuleId: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  rule?: ReturnType<typeof ruleSnapshot>;
};

function ruleSnapshot(rule: AlertRule): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    state: rule.state,
    evaluationIntervalSec: rule.evaluationIntervalSec,
    stateChangedAt: rule.stateChangedAt,
    lastEvaluatedAt: rule.lastEvaluatedAt ?? null,
    pendingSince: rule.pendingSince ?? null,
  };
}

function isFreshForPlan(rule: AlertRule, plan: RemediationPlan): boolean {
  if (!rule.lastEvaluatedAt || !plan.verificationStartedAt) return false;
  return Date.parse(rule.lastEvaluatedAt) >= Date.parse(plan.verificationStartedAt);
}

function evidence(
  plan: RemediationPlan,
  reason: string,
  checkedAt: string,
  rule?: AlertRule,
): VerificationEvidence {
  return {
    reason,
    checkedAt,
    targetObject: plan.targetObject,
    validationMethod: plan.validationMethod,
    linkedAlertRuleId: plan.linkedAlertRuleId,
    startedAt: plan.verificationStartedAt,
    deadlineAt: plan.verificationDeadlineAt,
    ...(rule ? { rule: ruleSnapshot(rule) } : {}),
  };
}

export class PlanVerificationService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PlanVerificationServiceOptions) {}

  start(): void {
    if (this.timer) return;
    void this.recoverInterrupted().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'plan-verification: startup recovery sweep failed');
    });
    const intervalMs = this.opts.sweepIntervalMs
      ?? (Number(process.env['PLAN_VERIFICATION_SWEEP_MS']) || 15_000);
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'plan-verification: sweep threw');
      });
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async onExecutionOutcome(
    orgId: string,
    planId: string,
    outcome: { kind: string },
  ): Promise<RemediationPlan | null> {
    if (outcome.kind !== 'completed') return this.opts.plans.findByIdInOrg(orgId, planId);
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) return null;
    return this.beginVerification(plan);
  }

  async beginVerification(plan: RemediationPlan): Promise<RemediationPlan | null> {
    const checkedAt = this.nowIso();
    if (!plan.linkedAlertRuleId) {
      return this.opts.plans.updatePlan(plan.orgId, plan.id, {
        verificationStatus: 'skipped',
        verificationStartedAt: null,
        verificationDeadlineAt: null,
        verificationEvidenceJson: evidence(plan, 'no linked alert rule', checkedAt),
      });
    }

    const rule = await this.opts.alertRules.findById(plan.linkedAlertRuleId);
    if (!rule) {
      return this.finish(plan, 'inconclusive', 'linked alert rule missing', checkedAt);
    }
    if (rule.state === 'disabled') {
      return this.finish(plan, 'inconclusive', 'linked alert rule disabled', checkedAt, rule);
    }

    const waitMs = Math.max(
      (rule.evaluationIntervalSec || 0) * 2 * 1000,
      this.floorMs(),
    );
    const startedAt = checkedAt;
    const deadlineAt = new Date(this.now().getTime() + waitMs).toISOString();
    return this.opts.plans.updatePlan(plan.orgId, plan.id, {
      verificationStatus: 'waiting',
      verificationStartedAt: startedAt,
      verificationDeadlineAt: deadlineAt,
      verificationEvidenceJson: {
        ...evidence(
          {
            ...plan,
            verificationStartedAt: startedAt,
            verificationDeadlineAt: deadlineAt,
          },
          'waiting for linked alert rule evaluation',
          checkedAt,
          rule,
        ),
        waitMs,
      },
    });
  }

  /**
   * Startup recovery. Marking a plan `applied` (executor) and starting its
   * verification (this service) are two independent writes, so a crash or
   * restart in between leaves the plan applied with `verification_status`
   * still `not_started` — and nothing picks that up, because the periodic
   * sweeper only looks at rows already marked `waiting`. Those plans hang
   * forever. Resume them here, then run one sweep so plans that blew past
   * their deadline while the process was down get finalized instead of
   * sitting in `waiting`.
   *
   * Called once from `start()`, before the periodic timer, so it never races
   * an in-flight `beginVerification` in this process.
   */
  async recoverInterrupted(limit = 100): Promise<number> {
    const stranded = await this.opts.plans.listAppliedAwaitingVerification(limit);
    let recovered = 0;
    for (const plan of stranded) {
      const after = await this.beginVerification(plan);
      if (!after || after.verificationStatus === 'not_started') continue;
      recovered += 1;
      log.warn(
        { planId: plan.id, orgId: plan.orgId, verificationStatus: after.verificationStatus },
        'plan-verification: resumed verification interrupted before this API process started',
      );
    }
    return recovered + await this.sweep(limit);
  }

  async sweep(limit = 100): Promise<number> {
    const plans = await this.opts.plans.listWaitingVerification(limit);
    let updated = 0;
    for (const plan of plans) {
      const after = await this.checkWaitingPlan(plan);
      if (after && after.verificationStatus !== 'waiting') updated += 1;
    }
    return updated;
  }

  async checkWaitingPlan(plan: RemediationPlan): Promise<RemediationPlan | null> {
    const checkedAt = this.nowIso();
    if (!plan.linkedAlertRuleId) {
      return this.opts.plans.updatePlan(plan.orgId, plan.id, {
        verificationStatus: 'skipped',
        verificationEvidenceJson: evidence(plan, 'no linked alert rule', checkedAt),
      });
    }

    const rule = await this.opts.alertRules.findById(plan.linkedAlertRuleId);
    if (!rule) {
      return this.finish(plan, 'inconclusive', 'linked alert rule missing', checkedAt);
    }
    if (rule.state === 'disabled') {
      return this.finish(plan, 'inconclusive', 'linked alert rule disabled', checkedAt, rule);
    }

    const deadlineReached = plan.verificationDeadlineAt
      ? Date.parse(plan.verificationDeadlineAt) <= this.now().getTime()
      : true;
    const fresh = isFreshForPlan(rule, plan);

    if ((rule.state === 'normal' || rule.state === 'resolved') && fresh) {
      return this.finish(plan, 'passed', 'linked alert rule evaluated normal/resolved', checkedAt, rule);
    }

    if (!deadlineReached) return plan;

    if (!fresh) {
      return this.finish(plan, 'inconclusive', 'linked alert rule was not evaluated after verification started', checkedAt, rule);
    }
    if (rule.state === 'pending' || rule.state === 'firing') {
      return this.finish(plan, 'failed', 'linked alert rule still pending/firing at deadline', checkedAt, rule);
    }
    return this.finish(plan, 'inconclusive', `linked alert rule state '${rule.state}' cannot verify remediation`, checkedAt, rule);
  }

  private async finish(
    plan: RemediationPlan,
    status: Exclude<RemediationPlanVerificationStatus, 'not_started' | 'waiting'>,
    reason: string,
    checkedAt: string,
    rule?: AlertRule,
  ): Promise<RemediationPlan | null> {
    return this.opts.plans.updatePlan(plan.orgId, plan.id, {
      verificationStatus: status,
      verificationEvidenceJson: evidence(plan, reason, checkedAt, rule),
    });
  }

  private floorMs(): number {
    return this.opts.floorMs
      ?? (Number(process.env['PLAN_VERIFICATION_FLOOR_MS']) || 60_000);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
