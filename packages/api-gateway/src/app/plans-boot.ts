/**
 * Boot wiring for the remediation-plan flow.
 *
 * Single responsibility: build a `PlanExecutorService` configured to run
 * plan steps through `KubectlExecutionAdapter` against the org's ops
 * connectors, mount `/api/plans`, and connect it to the approval bus so
 * plan-step approvals advance the plan automatically.
 *
 * Lives next to `auth-routes.ts` / `rbac-routes.ts` / `domain-routes.ts`
 * to keep `domain-routes.ts` focused on per-route mounts and not on
 * service construction.
 */

import type { Application } from 'express';
import { createLogger } from '@agentic-obs/server-utils/logging';
import { KubectlExecutionAdapter } from '@agentic-obs/adapters';
import type {
  IApprovalRequestRepository,
  IConnectorRepository,
  IRemediationPlanRepository,
  RemediationPlan,
  RemediationPlanStep,
} from '@agentic-obs/data-layer';
import type { EventEmittingApprovalRepository } from '@agentic-obs/data-layer';
import {
  DefaultOpsSecretRefResolver,
  type OpsSecretRefResolver,
} from '../services/ops-secret-ref-resolver.js';
import { PlanExecutorService } from '../services/plan-executor-service.js';
import { createPlansRouter } from '../routes/plans.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

const log = createLogger('plans-boot');

export interface MountPlansDeps {
  app: Application;
  plans: IRemediationPlanRepository;
  approvals: IApprovalRequestRepository;
  approvalEventStore: EventEmittingApprovalRepository;
  connectors: IConnectorRepository;
  ac: AccessControlSurface;
  /** Optional audit writer; one row per plan-step execution when wired. */
  audit?: import('../auth/audit-writer.js').AuditWriter;
  /** Resolve the team that owns the investigation's alert/folder context. */
  resolveRequesterTeamId?: (orgId: string, investigationId: string) => Promise<string | null>;
  /** Override for tests; defaults to env-backed `DefaultOpsSecretRefResolver`. */
  secretResolver?: OpsSecretRefResolver;
}

/**
 * Mount `/api/plans` and start listening for plan-step approval events.
 *
 * Wires:
 *   1. PlanExecutorService — resolves a connector + builds a per-call
 *      KubectlExecutionAdapter (write mode) keyed on the step's
 *      `paramsJson.connectorId`.
 *   2. /api/plans router — list / get / approve / reject / cancel /
 *      retry-step. Already RBAC-gated.
 *   3. approvalEventStore.onResolved — when a plan-step ApprovalRequest
 *      is approved or rejected, drive the executor forward. We filter
 *      to events that carry a `planId` in their context so non-plan
 *      approvals (e.g. ad-hoc ops.run_command) are ignored.
 */
export function mountPlans(deps: MountPlansDeps): void {
  const secretResolver = deps.secretResolver ?? new DefaultOpsSecretRefResolver();

  const adapterFor = async (plan: RemediationPlan, step: RemediationPlanStep) => {
    const connectorId = typeof step.paramsJson['connectorId'] === 'string'
      ? step.paramsJson['connectorId']
      : '';
    if (!connectorId) {
      throw new Error(`step ${step.ordinal}: paramsJson.connectorId is required`);
    }
    const connector = await deps.connectors.get(connectorId, { orgId: plan.orgId });
    if (!connector) {
      throw new Error(`connector "${connectorId}" not found in org ${plan.orgId}`);
    }
    return new KubectlExecutionAdapter({
      // The connector record carries either an inline encrypted secret OR
      // a secretRef pointer. resolveKubeconfig prefers the inline secret
      // when present (already decrypted by the repo) and falls back to
      // the ref resolver for env://, file://, vault:// schemes.
      resolveKubeconfig: async () => {
        const inline = connector.config['kubeconfig'];
        const secretRef = connector.config['secretRef'];
        if (typeof inline === 'string' && inline) return inline;
        if (typeof secretRef === 'string' && secretRef) return secretResolver.resolve(secretRef);
        throw new Error(`connector "${connectorId}" has no kubeconfig or secretRef configured`);
      },
      allowedNamespaces: Array.isArray(connector.config['allowedNamespaces'])
        ? connector.config['allowedNamespaces'].filter((v): v is string => typeof v === 'string')
        : [],
      mode: 'write',
    });
  };

  const executor = new PlanExecutorService({
    plans: deps.plans,
    approvals: deps.approvals,
    adapterFor,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.resolveRequesterTeamId ? { resolveRequesterTeamId: deps.resolveRequesterTeamId } : {}),
  });

  deps.app.use('/api/plans', createPlansRouter({
    plans: deps.plans,
    executor,
    ac: deps.ac,
  }));

  // Drive the executor forward when a per-step ApprovalRequest is
  // resolved. Plan-step approvals are tagged with `context.planId`; we
  // filter on that so we don't wake up the executor for unrelated
  // approvals (ad-hoc ops.run_command from the chat UI, for example).
  deps.approvalEventStore.onResolved((approval) => {
    const ctx = approval.context as { planId?: unknown; stepOrdinal?: unknown };
    if (typeof ctx.planId !== 'string' || typeof ctx.stepOrdinal !== 'number') return;
    if (approval.action.type !== 'ops.run_command') return;
    void resumeExecutor(executor, approval, deps.plans);
  });

  // Expiry sweeper. Once per minute, mark `pending_approval` plans whose
  // expires_at has passed as `expired`. PLAN_APPROVAL_TTL_MS controls the
  // initial expiry stamp at plan creation time (data-layer); this sweeper
  // is just the GC pass that reflects the timeout in the row's status.
  const sweepIntervalMs = Number(process.env['PLAN_EXPIRY_SWEEP_MS']) || 60_000;
  const sweepTimer = setInterval(() => {
    void deps.plans.expireStale(new Date().toISOString()).then((n) => {
      if (n > 0) log.info({ expired: n }, 'plan-executor: swept expired plans');
    }).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'plan-executor: expireStale threw');
    });
  }, sweepIntervalMs);
  // Don't keep the event loop alive just for this timer.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  log.info('plan-executor wired and /api/plans mounted');
}

async function resumeExecutor(
  executor: PlanExecutorService,
  approval: { id: string; status: string; context: unknown },
  plans: IRemediationPlanRepository,
): Promise<void> {
  const ctx = approval.context as { planId?: string };
  // Look up the plan to recover orgId; the executor needs it.
  if (typeof ctx.planId !== 'string') return;
  const plan = await plans.findById(ctx.planId);
  if (!plan) {
    log.warn({ approvalId: approval.id, planId: ctx.planId }, 'approval resumed but plan not found');
    return;
  }
  try {
    if (approval.status === 'approved') {
      await executor.onStepApproved(plan.orgId, approval.id);
    } else if (approval.status === 'rejected') {
      await executor.onStepRejected(plan.orgId, approval.id);
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), approvalId: approval.id, planId: ctx.planId },
      'plan executor resume threw',
    );
  }
}
