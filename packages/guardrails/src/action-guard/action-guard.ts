import type {
  ActionRisk,
  ActionSource,
  ConfirmationMode,
  GuardedDecision,
  ProposedAction,
} from '@agentic-obs/common';
import { redactParamsForAudit } from '@agentic-obs/common';
import type { PolicyRule, GuardDecision } from './types.js';

export interface ActionInput {
  type: string;
  targetService?: string;
  env?: string;
  params?: Record<string, unknown>;
}

/**
 * Caller-provided connector policy check. Return true iff `actorUserId` is
 * permitted to perform `capability` on `connectorId` within `orgId`. The
 * guard stays decoupled from the runtime policy repository; api-gateway wires
 * this to `connector_team_policies`.
 *
 * `actorUserId` is undefined for non-user sources (background_agent,
 * system) — the checker may still apply org-wide policy.
 */
export type PermissionChecker = (input: {
  actorUserId?: string;
  orgId: string;
  connectorId: string;
  capability: string;
  verb?: string;
  scope?: Record<string, unknown>;
}) => Promise<boolean> | boolean;

/**
 * Optional bootstrap-default tuple for connector templates. Runtime GuardedAction
 * decisions do not consult this list; connector policy lookup is the source of
 * truth. The shape remains exported for data-layer/template bootstrap code.
 */
export interface CapabilityAllowEntry {
  connectorId: string | '*';
  capability: string;
  verb: string;
  /**
   * Optional zod-like validator. Returns null on success, a string reason
   * on failure. Kept dependency-free so guardrails doesn't pull zod in
   * just for this.
   */
  validateParams?: (params: Record<string, unknown>) => string | null;
}

/**
 * Audit hook — every decision (allow OR deny) is reported here. Failures
 * inside the audit hook MUST NOT block the decision; callers should
 * fire-and-forget. Returning an auditId is optional (for correlation).
 */
export type GuardAuditWriter = (entry: {
  source: ActionSource;
  actorUserId?: string;
  orgId: string;
  connectorId: string;
  capability: string;
  verb: string;
  resource?: { kind: string; name: string; namespace?: string };
  risk: ActionRisk;
  decision: 'allow' | 'deny';
  confirmationMode?: ConfirmationMode;
  reason?: string;
  paramsRedacted: Record<string, unknown>;
}) => Promise<string | undefined> | string | undefined | void;

export interface GuardedActionGuardOptions {
  permissionChecker: PermissionChecker;
  auditWriter?: GuardAuditWriter;
  validateParams?: (action: ProposedAction) => string | null;
}

export class ActionGuard {
  // ---- legacy policy-rule mode (kept for backwards compat) ----
  private readonly rules: PolicyRule[];

  // ---- new GuardedAction mode ----
  private readonly permissionChecker?: PermissionChecker;
  private readonly auditWriter?: GuardAuditWriter;
  private readonly validateParams?: (action: ProposedAction) => string | null;

  constructor(rulesOrOpts: PolicyRule[] | GuardedActionGuardOptions) {
    if (Array.isArray(rulesOrOpts)) {
      this.rules = rulesOrOpts;
    } else {
      this.rules = [];
      this.permissionChecker = rulesOrOpts.permissionChecker;
      this.auditWriter = rulesOrOpts.auditWriter;
      this.validateParams = rulesOrOpts.validateParams;
    }
  }

  // -------------------------------------------------------------------------
  // GuardedAction decision
  // -------------------------------------------------------------------------

  /**
   * Evaluate a `ProposedAction` and return a `GuardedDecision`.
   *
   * Order:
   *   1. Optional caller-supplied param validation. Invalid → deny.
   *   2. Connector policy check. Denied → deny (NEVER silently upgraded).
   *   3. Compute confirmationMode from source × risk.
   *   4. Write audit row (allow or deny).
   */
  async decide(action: ProposedAction): Promise<GuardedDecision> {
    if (!this.permissionChecker) {
      throw new Error('ActionGuard.decide requires permissionChecker (use new constructor signature)');
    }

    if (this.validateParams) {
      const reason = this.validateParams(action);
      if (reason) {
        return this.finalizeDeny(action, `invalid params: ${reason}`);
      }
    }

    const permitted = await this.permissionChecker({
      actorUserId: action.actorUserId,
      orgId: action.orgId,
      connectorId: action.connectorId,
      capability: action.capability,
      verb: action.verb,
      scope: action.scope,
    });
    if (!permitted) {
      return this.finalizeDeny(action, 'permission denied');
    }

    const confirmationMode = pickConfirmationMode(action.source, action.risk);
    return this.finalizeAllow(action, confirmationMode);
  }

  private async finalizeAllow(
    action: ProposedAction,
    confirmationMode: ConfirmationMode,
  ): Promise<GuardedDecision> {
    const auditId = await this.writeAudit(action, 'allow', confirmationMode, undefined);
    return { kind: 'allow', confirmationMode, auditId };
  }

  private async finalizeDeny(
    action: ProposedAction,
    reason: string,
  ): Promise<GuardedDecision> {
    const auditId = await this.writeAudit(action, 'deny', undefined, reason);
    return { kind: 'deny', reason, auditId };
  }

  private async writeAudit(
    action: ProposedAction,
    decision: 'allow' | 'deny',
    confirmationMode: ConfirmationMode | undefined,
    reason: string | undefined,
  ): Promise<string | undefined> {
    if (!this.auditWriter) return undefined;
    try {
      const id = await this.auditWriter({
        source: action.source,
        actorUserId: action.actorUserId,
        orgId: action.orgId,
        connectorId: action.connectorId,
        capability: action.capability,
        verb: action.verb,
        resource: action.resource,
        risk: action.risk,
        decision,
        confirmationMode,
        reason,
        paramsRedacted: redactParamsForAudit(action.params),
      });
      return typeof id === 'string' ? id : undefined;
    } catch {
      // audit failures must not break the decision — by design.
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Legacy policy-rule mode (untouched).
  // -------------------------------------------------------------------------

  evaluate(action: ActionInput): GuardDecision {
    for (const rule of this.rules) {
      if (!this.matchesRule(action, rule)) {
        continue;
      }

      if (rule.conditions) {
        const conditionResult = this.checkConditions(action, rule);
        if (conditionResult !== null) {
          return conditionResult;
        }
      }

      return {
        effect: rule.effect,
        matchedRule: rule,
        reason: rule.description ?? `Matched rule: ${rule.id}`,
      };
    }

    return {
      effect: 'deny',
      reason: 'No matching policy rule (deny-by-default)',
    };
  }

  private matchesRule(action: ActionInput, rule: PolicyRule): boolean {
    const { actionType, targetService, env } = rule.match;

    if (actionType !== undefined && actionType !== '*' && actionType !== action.type) {
      return false;
    }

    if (targetService !== undefined && targetService !== '*' && targetService !== action.targetService) {
      return false;
    }

    if (env !== undefined && env !== '*' && env !== action.env) {
      return false;
    }

    return true;
  }

  private checkConditions(action: ActionInput, rule: PolicyRule): GuardDecision | null {
    const conditions = rule.conditions!;
    const params = action.params ?? {};

    if (conditions.maxReplicas !== undefined) {
      const replicas = params['replicas'];
      if (typeof replicas === 'number' && replicas > conditions.maxReplicas) {
        return {
          effect: 'deny',
          matchedRule: rule,
          reason: `Replicas ${replicas} exceed maximum allowed ${conditions.maxReplicas}`,
        };
      }
    }

    if (conditions.allowedNamespaces !== undefined) {
      const namespace = params['namespace'];
      if (typeof namespace === 'string' && !conditions.allowedNamespaces.includes(namespace)) {
        return {
          effect: 'deny',
          matchedRule: rule,
          reason: `Namespace "${namespace}" is not in the allowed list: ${conditions.allowedNamespaces.join(', ')}`,
        };
      }
    }

    if (conditions.timeWindow !== undefined) {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = this.parseTime(conditions.timeWindow.start);
      const endMinutes = this.parseTime(conditions.timeWindow.end);

      const inWindow =
        startMinutes <= endMinutes
          ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
          : currentMinutes >= startMinutes || currentMinutes <= endMinutes;

      if (!inWindow) {
        return {
          effect: 'deny',
          matchedRule: rule,
          reason: `Action not allowed outside time window ${conditions.timeWindow.start}-${conditions.timeWindow.end}`,
        };
      }
    }

    return null;
  }

  private parseTime(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  }
}

/**
 * Decision matrix from source × risk → confirmationMode.
 *
 * source=background_agent, risk=high|critical → formal_approval
 * source=background_agent, risk=low|medium    → none
 * source=user_conversation/manual_ui,
 *        risk=critical                         → strong_user_confirm
 *        risk=high                             → strong_user_confirm
 *        risk=medium                           → user_confirm
 *        risk=low                              → none
 * source=system → none (already pre-approved upstream)
 */
export function pickConfirmationMode(
  source: ActionSource,
  risk: ActionRisk,
): ConfirmationMode {
  if (source === 'background_agent') {
    return risk === 'high' || risk === 'critical' ? 'formal_approval' : 'none';
  }
  if (source === 'user_conversation' || source === 'manual_ui') {
    if (risk === 'critical' || risk === 'high') return 'strong_user_confirm';
    if (risk === 'medium') return 'user_confirm';
    return 'none';
  }
  // source === 'system'
  return 'none';
}
