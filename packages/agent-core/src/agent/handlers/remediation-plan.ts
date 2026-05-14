/**
 * Agent tools for proposing remediation plans.
 *
 * Phase 4 of `auto-remediation design notes`. Two tools:
 *
 *   - remediation_plan_create        — primary plan (auto-creates a
 *                                       plan-level ApprovalRequest)
 *   - remediation_plan_create_rescue — rescue/undo plan paired with a
 *                                       primary; no ApprovalRequest is
 *                                       created until a human triggers it
 *                                       from the UI after a failure.
 *
 * Validation: every step's argv is run through P6's `checkKubectl(...,
 * 'write', allowedNamespaces)` allowlist BEFORE any DB write. If any
 * step is denied, the whole plan is rejected — no half-persisted plan.
 *
 * Execution: NOT done here. The PlanExecutorService (P5) is the only
 * thing that runs plan steps. This file just persists the proposal and
 * surfaces it for approval.
 */

import { checkKubectl, parseKubectlArgv } from '@agentic-obs/adapters';
import type {
  NewRemediationPlanStep,
  RemediationPlanStepKind,
} from '../types.js';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

interface RawStepInput {
  kind?: unknown;
  commandText?: unknown;
  paramsJson?: unknown;
  dryRunText?: unknown;
  riskNote?: unknown;
  continueOnError?: unknown;
}

interface ValidatedStep extends NewRemediationPlanStep {
  /** retained on the parsed step so we can validate against the connector */
  connectorId: string;
}

/**
 * Coerce a single raw step blob into the shape the repository expects, OR
 * return a string explaining why we can't. Strict — agents that produce
 * sloppy step payloads should see a clear error string they can recover
 * from on the next turn.
 */
function parseStep(raw: unknown, idx: number): ValidatedStep | string {
  if (!raw || typeof raw !== 'object') {
    return `step[${idx}] is not an object`;
  }
  const r = raw as RawStepInput;
  const kind = typeof r.kind === 'string' ? r.kind : '';
  if (!kind) return `step[${idx}].kind is required`;
  if (kind !== 'ops.run_command') {
    return `step[${idx}].kind '${kind}' is not supported (only 'ops.run_command' today)`;
  }
  const commandText = typeof r.commandText === 'string' ? r.commandText.trim() : '';
  if (!commandText) return `step[${idx}].commandText is required`;

  if (!r.paramsJson || typeof r.paramsJson !== 'object' || Array.isArray(r.paramsJson)) {
    return `step[${idx}].paramsJson must be an object`;
  }
  const params = r.paramsJson as Record<string, unknown>;
  const argv = params['argv'];
  const connectorId = params['connectorId'];
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string') || argv.length === 0) {
    return `step[${idx}].paramsJson.argv must be a non-empty string array (kubectl argv without 'kubectl')`;
  }
  if (typeof connectorId !== 'string' || !connectorId) {
    return `step[${idx}].paramsJson.connectorId must be the id of a configured ops connector`;
  }
  return {
    kind: kind as RemediationPlanStepKind,
    commandText,
    paramsJson: params,
    connectorId,
    ...(typeof r.dryRunText === 'string' ? { dryRunText: r.dryRunText } : {}),
    ...(typeof r.riskNote === 'string' ? { riskNote: r.riskNote } : {}),
    ...(typeof r.continueOnError === 'boolean' ? { continueOnError: r.continueOnError } : {}),
  };
}

/**
 * Look up the connector by id and check the step's argv against the write
 * allowlist scoped to that connector's allowedNamespaces. Returns null on
 * pass; a string reason on fail.
 */
function validateStepAgainstConnector(
  ctx: ActionContext,
  step: ValidatedStep,
  idx: number,
): string | null {
  const connector = ctx.opsConnectors?.find((c) => c.id === step.connectorId);
  if (!connector) {
    return `step[${idx}].paramsJson.connectorId '${step.connectorId}' is not configured for this org`;
  }
  const decision = checkKubectl(
    step.paramsJson['argv'] as string[],
    'write',
    connector.namespaces ?? [],
  );
  if (!decision.allow) {
    return `step[${idx}] (${step.commandText}): ${decision.reason ?? 'rejected by allowlist'}`;
  }
  return null;
}

async function createPlanCommon(
  ctx: ActionContext,
  args: Record<string, unknown>,
  rescueForPlanId: string | null,
): Promise<string> {
  if (!ctx.remediationPlans) {
    return 'Error: remediation plan store is not available.';
  }
  const investigationId = String(args['investigationId'] ?? '');
  const summary = String(args['summary'] ?? '').trim();
  const stepsRaw = args['steps'];
  if (!investigationId) return 'Error: "investigationId" is required.';
  if (!summary) return 'Error: "summary" is required.';
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return 'Error: "steps" must be a non-empty array.';
  }

  // Parse + structurally validate every step before any I/O.
  const parsed: ValidatedStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const result = parseStep(stepsRaw[i], i);
    if (typeof result === 'string') return `Error: ${result}`;
    parsed.push(result);
  }
  // Allowlist-validate against the connector. We refuse the WHOLE plan if
  // any step would be denied — half-persisted plans are worse than a clear
  // rejection that lets the agent retry.
  for (let i = 0; i < parsed.length; i++) {
    const reason = validateStepAgainstConnector(ctx, parsed[i] as ValidatedStep, i);
    if (reason) return `Error: ${reason}`;
  }

  const expiresInMs = typeof args['expiresInMs'] === 'number' ? args['expiresInMs'] : undefined;
  const expiresAt = typeof expiresInMs === 'number'
    ? new Date(Date.now() + expiresInMs).toISOString()
    : undefined;

  const tool = rescueForPlanId === null ? 'remediation_plan_create' : 'remediation_plan_create_rescue';
  const displayText = rescueForPlanId === null
    ? `Proposing remediation plan: ${summary.slice(0, 60)}`
    : `Proposing rescue plan for ${rescueForPlanId}: ${summary.slice(0, 60)}`;

  let observation = '';
  await withToolEventBoundary(
    ctx.sendEvent,
    tool,
    { investigationId, summary, stepCount: parsed.length, ...(rescueForPlanId ? { rescueForPlanId } : {}) },
    displayText,
    async () => {
      const plan = await ctx.remediationPlans!.create({
        orgId: ctx.identity.orgId,
        investigationId,
        rescueForPlanId,
        summary,
        createdBy: 'agent',
        ...(expiresAt ? { expiresAt } : {}),
        steps: parsed.map((p) => {
          // Drop our `connectorId` helper field; everything else flows through.
          const { connectorId: _connectorId, ...rest } = p;
          void _connectorId;
          return rest as NewRemediationPlanStep;
        }),
      });

      // Primary plans get an auto plan-level ApprovalRequest so they show
      // up in /api/approvals + the ActionCenter UI immediately. Rescue
      // plans do NOT — they're invoked on demand by an operator.
      if (rescueForPlanId === null && ctx.approvalRequests) {
        // Multi-team scope tags (approval-scope design notes
        // §3.6). The plan-level approval is what lands in /api/approvals,
        // so it's the row that needs scope-narrowing for visibility. We
        // pull connector + namespace from the first ops step; team is
        // resolved upstream and (for now) not threaded through ctx — left
        // null with a TODO. Without these tags multi-team customers see
        // every cluster's plan-level approvals; this is the fix.
        const firstOpsStep = parsed.find(
          (s) => typeof (s.paramsJson as Record<string, unknown>)?.['argv'] !== 'undefined'
            && typeof s.connectorId === 'string'
            && s.connectorId.length > 0,
        );
        const opsConnectorId = firstOpsStep?.connectorId ?? null;
        const targetNamespace = firstOpsStep
          ? (parseKubectlArgv((firstOpsStep.paramsJson as { argv: string[] }).argv).namespace ?? null)
          : null;
        // TODO(approvals-multi-team): resolve requesterTeamId via ctx.
        // Needs alertRule.investigation_id → folder → team chain wired
        // through ctx (not currently exposed in agent-core). Tracked
        // separately; null is the safe default — wildcard `approvals:*`
        // grants still match.
        const requesterTeamId: string | null = null;

        const submitted = await ctx.approvalRequests.submit({
          action: {
            type: 'plan',
            targetService: 'remediation-plan',
            params: { planId: plan.id, summary, stepCount: plan.steps.length },
          },
          context: {
            investigationId,
            requestedBy: 'agent',
            reason: summary,
            // planId is also stamped here so the approval-execute path can
            // find the plan without re-parsing action.params.
            ...{ planId: plan.id } as Record<string, unknown>,
          },
          opsConnectorId,
          targetNamespace,
          requesterTeamId,
        });
        await ctx.remediationPlans!.updatePlan(ctx.identity.orgId, plan.id, {
          approvalRequestId: submitted.id,
        });
      }

      observation = rescueForPlanId === null
        ? `Created remediation plan "${summary}" (id: ${plan.id}, ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}). Awaiting approval.`
        : `Created rescue plan "${summary}" (id: ${plan.id}, ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}) for plan ${rescueForPlanId}. It will only run if an operator triggers it from the UI.`;
      return observation;
    },
  );
  return observation;
}

export async function handleRemediationPlanCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  return createPlanCommon(ctx, args, null);
}

export async function handleRemediationPlanCreateRescue(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const rescueForPlanId = String(args['rescueForPlanId'] ?? '').trim();
  if (!rescueForPlanId) return 'Error: "rescueForPlanId" is required for a rescue plan.';
  // Verify the parent plan exists in the same org before creating a child.
  if (ctx.remediationPlans) {
    const parent = await ctx.remediationPlans.findByIdInOrg(ctx.identity.orgId, rescueForPlanId);
    if (!parent) return `Error: parent plan "${rescueForPlanId}" not found.`;
  }
  return createPlanCommon(ctx, args, rescueForPlanId);
}
