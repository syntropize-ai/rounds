/**
 * PlanExecutorService — the engine that drives a RemediationPlan from
 * `approved` to terminal state.
 *
 * Phase 5 of `docs/design/auto-remediation.md`. The plan is the unit of
 * approval; this service is the unit of execution. State machine:
 *
 *   pending_approval ──approve──► approved ──startExecution──► executing
 *   executing ──all steps done──► completed
 *   executing ──step fails──────► failed (later steps marked skipped)
 *   executing ──cancel──────────► cancelled
 *   pending_approval ──reject──► rejected
 *   pending_approval ──ttl pass─► expired (handled by repo.expireStale)
 *
 * Execution semantics:
 *
 *   - autoEdit=true:  run every step in order without per-step approvals.
 *   - autoEdit=false: before each step, create an `ApprovalRequest`
 *     (`action.type='ops.run_command'`, `context.planId`, `context.stepOrdinal`)
 *     and pause. The caller resumes by invoking `onStepApproved(approvalId)`
 *     after that ApprovalRequest is approved (e.g. by subscribing to the
 *     existing approvalStore.onResolved hook).
 *   - On failure: if `step.continueOnError`, mark the step failed and
 *     proceed to the next step; otherwise mark the plan failed, mark
 *     remaining `pending` steps `skipped`, and stop.
 *   - `retryStep(planId, ordinal)` re-runs a single failed step on demand;
 *     if it succeeds, execution continues from the next step.
 *
 * The service has no direct ExecutionAdapter dependency. It calls
 * `adapterFor(plan, step)` to obtain the right adapter per step — this is
 * how a kubectl adapter (Phase 6) is bound to the plan's connector at the
 * call site without dragging connector-resolution into this file.
 */

import { createLogger } from '@agentic-obs/common/logging';
import type { Identity, ProposedAction } from '@agentic-obs/common';
import type {
  ExecutionAdapter,
} from '@agentic-obs/adapters';
import type { ActionGuard } from '@agentic-obs/guardrails';
import type { AuditWriter } from '../auth/audit-writer.js';
import type {
  IApprovalRequestRepository,
  IRemediationPlanRepository,
  RemediationPlan,
  RemediationPlanStep,
} from '@agentic-obs/data-layer';
import { readNamespaceFromArgv } from './plan-namespaces.js';

const log = createLogger('plan-executor');

/** Output truncation cap (per stream) per design doc Phase 5. */
const STDIO_CAP_BYTES = 64 * 1024;

export interface PlanExecutorOptions {
  plans: IRemediationPlanRepository;
  /**
   * Optional. Required only when running plans with `autoEdit=false` —
   * the executor calls `submit()` to create per-step ApprovalRequests.
   * For autoEdit-only flows, leave this unset.
   */
  approvals?: IApprovalRequestRepository;
  /**
   * Build the right ExecutionAdapter for one step. Must respect:
   *   - the connector named in `step.paramsJson.connectorId` (if present)
   *   - mode: 'write' for plan execution
   * Returning a rejected promise aborts the plan with a halt-on-failure
   * error.
   */
  adapterFor: (plan: RemediationPlan, step: RemediationPlanStep) => Promise<ExecutionAdapter>;
  /**
   * Optional audit writer. When wired, every step execution emits an
   * `agent.plan_step` audit row with outcome ok/error and the connector +
   * verb in metadata. Boot wiring passes `authSub.audit`; tests omit.
   */
  audit?: AuditWriter;
  /**
   * Optional resolver: investigation id → owning team id, for the per-row
   * `requester_team_id` enrichment (approvals-multi-team-scope §3.6). Wire
   * this at boot from alertRule.investigationId → folderUid → folder team
   * binding. Returns NULL when the investigation isn't linked to a rule, the
   * rule has no folder, or the folder has no owning team. When the option
   * is omitted entirely, every approval row's `requester_team_id` is NULL
   * (back-compat for tests / installs that don't wire this yet).
   */
  resolveRequesterTeamId?: (
    orgId: string,
    investigationId: string,
  ) => Promise<string | null>;
  /**
   * Optional GuardedAction central gate. When wired, every step is
   * evaluated by `guard.decide()` before adapter execution as
   * defense-in-depth on top of the adapter-local allowlist. A `deny`
   * decision marks the step failed without spawning the adapter; an
   * `allow` decision proceeds (the per-step ApprovalRequest flow is the
   * formal_approval surfacing — `decide()` here just confirms the gate
   * is satisfied and writes an audit row).
   */
  guard?: ActionGuard;
}

export type PlanExecutorOutcome =
  | { kind: 'paused_for_approval'; stepOrdinal: number; approvalRequestId: string }
  | { kind: 'completed' }
  | { kind: 'failed'; failedOrdinal: number; reason: string }
  | { kind: 'cancelled' };

/** Shape we expect under `step.paramsJson` for `kind === 'ops.run_command'`. */
export interface OpsRunCommandStepParams {
  /** kubectl argv WITHOUT the leading `kubectl`. */
  argv: string[];
  /** Connector id to resolve credentials against. */
  connectorId: string;
}

function readOpsRunCommandParams(step: RemediationPlanStep): OpsRunCommandStepParams | null {
  if (step.kind !== 'ops.run_command') return null;
  const argv = step.paramsJson['argv'];
  const connectorId = step.paramsJson['connectorId'];
  if (
    !Array.isArray(argv) ||
    argv.some((a) => typeof a !== 'string') ||
    typeof connectorId !== 'string' ||
    !connectorId
  ) {
    return null;
  }
  return { argv: argv as string[], connectorId };
}

function truncate(s: string | null | undefined, cap: number): string | null {
  if (!s) return null;
  return s.length <= cap ? s : s.slice(s.length - cap);
}

export function capabilityForKubectlArgv(argv: readonly string[]): string {
  const verb = argv[0] ?? '';
  if (verb === 'scale') return 'runtime.scale';
  if (verb === 'rollout') return 'runtime.rollout';
  if (verb === 'restart') return 'runtime.restart';
  if (verb === 'delete') return 'runtime.delete';
  if (verb === 'logs') return 'runtime.logs';
  if (verb === 'events') return 'runtime.events';
  if (verb === 'get') return 'runtime.get';
  if (verb === 'list') return 'runtime.list';
  return `runtime.${verb || 'unknown'}`;
}

export class PlanExecutorService {
  constructor(private readonly opts: PlanExecutorOptions) {}

  /**
   * Approve a plan + maybe start executing it.
   *
   * - validates the plan is `pending_approval`
   * - sets autoEdit + status='approved' + resolved fields
   * - then sets status='executing' and runs `runNext` once
   *
   * Returns the outcome of the first execution step (paused / failed /
   * completed). For autoEdit=false this will typically be `paused_for_approval`
   * after creating the first step's ApprovalRequest.
   */
  async approve(
    orgId: string,
    planId: string,
    autoEdit: boolean,
    identity: Identity,
  ): Promise<PlanExecutorOutcome> {
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) throw new Error(`plan ${planId} not found`);
    if (plan.status !== 'pending_approval') {
      throw new Error(`plan ${planId} is ${plan.status}, cannot approve`);
    }
    const now = new Date().toISOString();
    await this.opts.plans.updatePlan(orgId, planId, {
      status: 'approved',
      autoEdit,
      resolvedAt: now,
      resolvedBy: identity.userId,
    });
    await this.opts.plans.updatePlan(orgId, planId, { status: 'executing' });
    return this.runNext(orgId, planId);
  }

  /**
   * Reject a plan. Permanent — once rejected, plan does not resume.
   */
  async reject(
    orgId: string,
    planId: string,
    identity: Identity,
  ): Promise<RemediationPlan | null> {
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) throw new Error(`plan ${planId} not found`);
    if (plan.status !== 'pending_approval') {
      throw new Error(`plan ${planId} is ${plan.status}, cannot reject`);
    }
    return this.opts.plans.updatePlan(orgId, planId, {
      status: 'rejected',
      resolvedAt: new Date().toISOString(),
      resolvedBy: identity.userId,
    });
  }

  /**
   * Cancel a plan that is approved or executing. Already-completed steps
   * stay completed; the next pending step is not run.
   */
  async cancel(
    orgId: string,
    planId: string,
    identity: Identity,
  ): Promise<RemediationPlan | null> {
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) throw new Error(`plan ${planId} not found`);
    if (plan.status !== 'approved' && plan.status !== 'executing') {
      throw new Error(`plan ${planId} is ${plan.status}, cannot cancel`);
    }
    return this.opts.plans.updatePlan(orgId, planId, {
      status: 'cancelled',
      resolvedAt: new Date().toISOString(),
      resolvedBy: identity.userId,
    });
  }

  /**
   * Step approved by a human (or by override). Look up which step the
   * approval gates, run it, and proceed to the next.
   *
   * Caller wires this up to `approvalStore.onResolved` (or equivalent)
   * filtered to plan-step approvals. We don't subscribe ourselves so the
   * service stays unit-testable without an event bus.
   */
  async onStepApproved(
    orgId: string,
    approvalRequestId: string,
  ): Promise<PlanExecutorOutcome> {
    const { plan, step } = await this.findStepByApproval(orgId, approvalRequestId);
    await this.executeStep(plan, step);
    return this.runNext(orgId, plan.id);
  }

  /**
   * Step rejected by a human. Halt the plan unless the step is marked
   * `continueOnError` (rare — usually a rejected step is intentional).
   */
  async onStepRejected(
    orgId: string,
    approvalRequestId: string,
  ): Promise<PlanExecutorOutcome> {
    const { plan, step } = await this.findStepByApproval(orgId, approvalRequestId);
    await this.opts.plans.updateStep(plan.id, step.ordinal, {
      status: 'failed',
      errorText: 'rejected by approver',
    });
    if (step.continueOnError) {
      return this.runNext(orgId, plan.id);
    }
    return this.haltPlan(orgId, plan.id, step.ordinal, 'rejected by approver');
  }

  /**
   * Re-run a single failed step. Only valid when the plan is in `failed`
   * state (or the step itself is `failed` mid-plan with continueOnError).
   * On success, execution proceeds; on failure, the plan stays failed.
   */
  async retryStep(
    orgId: string,
    planId: string,
    ordinal: number,
  ): Promise<PlanExecutorOutcome> {
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) throw new Error(`plan ${planId} not found`);
    const step = plan.steps.find((s) => s.ordinal === ordinal);
    if (!step) throw new Error(`step ${ordinal} not found on plan ${planId}`);
    if (step.status !== 'failed') {
      throw new Error(`step ${ordinal} is ${step.status}, only failed steps may be retried`);
    }
    // Reset the step + re-allow plan to progress.
    await this.opts.plans.updateStep(planId, ordinal, {
      status: 'pending',
      errorText: null,
      outputText: null,
      executedAt: null,
    });
    if (plan.status === 'failed') {
      // Reset skipped → pending so subsequent steps can run again.
      for (const s of plan.steps) {
        if (s.ordinal > ordinal && s.status === 'skipped') {
          await this.opts.plans.updateStep(planId, s.ordinal, { status: 'pending' });
        }
      }
      await this.opts.plans.updatePlan(orgId, planId, { status: 'executing' });
    }
    const refreshed = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!refreshed) throw new Error(`plan ${planId} disappeared during retry`);
    const target = refreshed.steps.find((s) => s.ordinal === ordinal);
    if (!target) throw new Error(`step ${ordinal} disappeared during retry`);
    await this.executeStep(refreshed, target);
    return this.runNext(orgId, planId);
  }

  // ---------------------------------------------------------------------
  // private
  // ---------------------------------------------------------------------

  /**
   * Drive forward from the first pending step. May:
   *   - mark the plan completed (no pending steps left)
   *   - create an ApprovalRequest and pause (autoEdit=false)
   *   - execute the next step in-process and recurse (autoEdit=true)
   */
  private async runNext(orgId: string, planId: string): Promise<PlanExecutorOutcome> {
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) throw new Error(`plan ${planId} not found`);

    if (plan.status === 'failed') {
      const failed = plan.steps.find((s) => s.status === 'failed');
      return {
        kind: 'failed',
        failedOrdinal: failed?.ordinal ?? -1,
        reason: failed?.errorText ?? 'plan failed',
      };
    }
    if (plan.status === 'cancelled') return { kind: 'cancelled' };

    const next = plan.steps.find((s) => s.status === 'pending');
    if (!next) {
      await this.opts.plans.updatePlan(orgId, planId, { status: 'completed' });
      return { kind: 'completed' };
    }

    if (plan.autoEdit) {
      await this.executeStep(plan, next);
      return this.runNext(orgId, planId);
    }

    // Per-step approval flow.
    if (!this.opts.approvals) {
      throw new Error(
        'PlanExecutorService: approvals repository is required when autoEdit=false',
      );
    }
    const params = readOpsRunCommandParams(next);
    // Per-row scope enrichment (approvals-multi-team-scope §3.6). For per-step
    // approvals the "first ops_run_command step" simply IS the step being
    // gated; non-ops kinds → both connector + namespace are NULL.
    const opsConnectorId = params?.connectorId ?? null;
    const targetNamespace = params
      ? readNamespaceFromArgv(params.argv)
      : null;
    const requesterTeamId = this.opts.resolveRequesterTeamId
      ? await this.opts.resolveRequesterTeamId(orgId, plan.investigationId)
      : null;
    const submitted = await this.opts.approvals.submit({
      action: {
        type: 'ops.run_command',
        targetService: params?.connectorId ?? 'unknown',
        params: {
          argv: params?.argv ?? [],
          connectorId: params?.connectorId ?? '',
          stepKind: next.kind,
        },
      },
      context: {
        investigationId: plan.investigationId,
        requestedBy: plan.createdBy,
        reason: next.commandText,
        // the design doc threads planId/stepOrdinal here; downstream code
        // already accepts unknown context fields.
        ...{ planId: plan.id, stepOrdinal: next.ordinal } as Record<string, unknown>,
      },
      opsConnectorId,
      targetNamespace,
      requesterTeamId,
    });
    await this.opts.plans.updateStep(plan.id, next.ordinal, {
      approvalRequestId: submitted.id,
    });
    log.info(
      { planId, stepOrdinal: next.ordinal, approvalRequestId: submitted.id },
      'plan-executor: paused for per-step approval',
    );
    return {
      kind: 'paused_for_approval',
      stepOrdinal: next.ordinal,
      approvalRequestId: submitted.id,
    };
  }

  /**
   * Run one step against its adapter. Persists status, output/error,
   * executedAt. On failure honors `continueOnError`.
   */
  private async executeStep(
    plan: RemediationPlan,
    step: RemediationPlanStep,
  ): Promise<void> {
    await this.opts.plans.updateStep(plan.id, step.ordinal, {
      status: 'executing',
      executedAt: new Date().toISOString(),
    });

    const params = readOpsRunCommandParams(step);
    if (!params) {
      const reason = `step ${step.ordinal} has invalid params for kind '${step.kind}'`;
      await this.opts.plans.updateStep(plan.id, step.ordinal, {
        status: 'failed',
        errorText: reason,
      });
      if (!step.continueOnError) {
        await this.haltPlan(plan.orgId, plan.id, step.ordinal, reason);
      }
      return;
    }

    if (this.opts.guard) {
      const proposed: ProposedAction = {
        orgId: plan.orgId,
        connectorId: params.connectorId,
        capability: capabilityForKubectlArgv(params.argv),
        verb: params.argv[0] ?? 'unknown',
        params: { argv: params.argv },
        // Plan steps come from already-approved plans, so by the time we
        // reach executeStep the formal_approval (or autoEdit) gate has
        // been satisfied upstream — source='system' avoids re-asking.
        risk: 'high',
        source: 'system',
      };
      const decision = await this.opts.guard.decide(proposed);
      if (decision.kind === 'deny') {
        await this.opts.plans.updateStep(plan.id, step.ordinal, {
          status: 'failed',
          errorText: `guard denied: ${decision.reason}`,
        });
        if (!step.continueOnError) {
          await this.haltPlan(plan.orgId, plan.id, step.ordinal, decision.reason);
        }
        return;
      }
    }

    const adapter = await this.opts.adapterFor(plan, step);
    const result = await adapter.execute({
      type: 'ops.run_command',
      targetService: params.connectorId,
      params: { argv: params.argv },
    });

    if (result.success) {
      await this.opts.plans.updateStep(plan.id, step.ordinal, {
        status: 'done',
        outputText: truncate(typeof result.output === 'string' ? result.output : JSON.stringify(result.output), STDIO_CAP_BYTES),
      });
      log.info(
        { planId: plan.id, stepOrdinal: step.ordinal },
        'plan-executor: step done',
      );
      void this.audit(plan, step, 'ok', undefined, params);
      return;
    }

    const errMsg = result.error ?? 'step failed';
    await this.opts.plans.updateStep(plan.id, step.ordinal, {
      status: 'failed',
      errorText: truncate(errMsg, STDIO_CAP_BYTES),
    });
    log.warn(
      { planId: plan.id, stepOrdinal: step.ordinal, err: errMsg },
      'plan-executor: step failed',
    );
    void this.audit(plan, step, 'error', errMsg, params);
    if (!step.continueOnError) {
      await this.haltPlan(plan.orgId, plan.id, step.ordinal, errMsg);
    }
  }

  /**
   * Mark the plan failed and skip every subsequent pending step.
   */
  private async haltPlan(
    orgId: string,
    planId: string,
    failedOrdinal: number,
    reason: string,
  ): Promise<PlanExecutorOutcome> {
    const fresh = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (fresh) {
      for (const s of fresh.steps) {
        if (s.ordinal > failedOrdinal && s.status === 'pending') {
          await this.opts.plans.updateStep(planId, s.ordinal, { status: 'skipped' });
        }
      }
    }
    await this.opts.plans.updatePlan(orgId, planId, { status: 'failed' });
    return { kind: 'failed', failedOrdinal, reason };
  }

  /**
   * Locate the step gated by the given ApprovalRequest id. Verifies the
   * approval exists and is in `approved` status (callers should have done
   * this; we double-check).
   */
  private audit(
    plan: RemediationPlan,
    step: RemediationPlanStep,
    outcome: 'ok' | 'error',
    errMsg: string | undefined,
    params: OpsRunCommandStepParams,
  ): void {
    if (!this.opts.audit) return;
    const verb = params.argv[0] ?? '';
    void this.opts.audit.log({
      action: 'agent.plan_step',
      actorType: 'service_account',
      actorId: plan.createdBy,
      orgId: plan.orgId,
      targetType: 'remediation_plan_step',
      targetId: `${plan.id}:${step.ordinal}`,
      outcome: outcome === 'ok' ? 'success' : 'failure',
      metadata: {
        planId: plan.id,
        stepOrdinal: step.ordinal,
        kind: step.kind,
        verb,
        connectorId: params.connectorId,
        ...(errMsg ? { error: errMsg.slice(0, 512) } : {}),
      },
    });
  }

  private async findStepByApproval(
    orgId: string,
    approvalRequestId: string,
  ): Promise<{ plan: RemediationPlan; step: RemediationPlanStep }> {
    if (!this.opts.approvals) {
      throw new Error('PlanExecutorService: approvals repository is required');
    }
    const approval = await this.opts.approvals.findById(approvalRequestId);
    if (!approval) throw new Error(`approval ${approvalRequestId} not found`);
    const ctx = approval.context as { planId?: unknown; stepOrdinal?: unknown };
    const planId = typeof ctx.planId === 'string' ? ctx.planId : null;
    const ordinal = typeof ctx.stepOrdinal === 'number' ? ctx.stepOrdinal : null;
    if (planId === null || ordinal === null) {
      throw new Error(`approval ${approvalRequestId} is not a plan-step approval`);
    }
    const plan = await this.opts.plans.findByIdInOrg(orgId, planId);
    if (!plan) throw new Error(`plan ${planId} not found`);
    const step = plan.steps.find((s) => s.ordinal === ordinal);
    if (!step) throw new Error(`step ${ordinal} not found on plan ${planId}`);
    return { plan, step };
  }
}
