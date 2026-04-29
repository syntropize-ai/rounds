/**
 * RemediationPlan — persistent home for a structured fix proposed by the
 * agent after an investigation. The unit of human approval. Steps are write
 * actions executed in order; halt-on-failure by default.
 *
 * Phase 3 of `docs/design/auto-remediation.md`. Schema only — no agent tools,
 * no executor, no API routes consume these types yet.
 */

export type RemediationPlanStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type RemediationPlanStepStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'skipped';

/**
 * Step kinds. Today only `ops.run_command` (kubectl shell), but the column
 * stores the discriminator so the union can grow without a migration.
 */
export type RemediationPlanStepKind = 'ops.run_command' | string;

export interface RemediationPlanStep {
  id: string;
  planId: string;
  ordinal: number;
  kind: RemediationPlanStepKind;
  /** Human-readable command, e.g. `kubectl scale deploy web -n app --replicas=3`. */
  commandText: string;
  /** Structured args for the executor; shape depends on `kind`. */
  paramsJson: Record<string, unknown>;
  /** Captured at plan-creation time via `ExecutionAdapter.dryRun`. */
  dryRunText: string | null;
  /** Free-form risk note from the agent. Surfaced in approval UI. */
  riskNote: string | null;
  /**
   * If true and this step fails, the plan continues with the next step
   * instead of halting. Default `false`.
   */
  continueOnError: boolean;
  status: RemediationPlanStepStatus;
  /** Approval request gating this step (per-step approval mode only). */
  approvalRequestId: string | null;
  executedAt: string | null;
  /** Truncated to 64 KB by the executor. */
  outputText: string | null;
  /** Truncated to 64 KB by the executor. */
  errorText: string | null;
}

export interface RemediationPlan {
  id: string;
  orgId: string;
  investigationId: string;
  /** Set on rescue plans; points at the primary plan they undo. NULL for primary plans. */
  rescueForPlanId: string | null;
  summary: string;
  status: RemediationPlanStatus;
  /**
   * Set at approval time. When true the executor skips per-step approval and
   * runs the whole plan. Scope is this plan only — does not carry across.
   */
  autoEdit: boolean;
  /** Plan-level approval request (created on plan persistence). */
  approvalRequestId: string | null;
  /** `'agent'` for LLM-emitted plans; otherwise the userId. */
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  steps: RemediationPlanStep[];
}

export interface NewRemediationPlanStep {
  kind: RemediationPlanStepKind;
  commandText: string;
  paramsJson: Record<string, unknown>;
  dryRunText?: string | null;
  riskNote?: string | null;
  continueOnError?: boolean;
}

export interface NewRemediationPlan {
  id?: string;
  orgId: string;
  investigationId: string;
  rescueForPlanId?: string | null;
  summary: string;
  /** Defaults to `'pending_approval'`. */
  status?: RemediationPlanStatus;
  autoEdit?: boolean;
  approvalRequestId?: string | null;
  createdBy: string;
  /** ISO timestamp; defaults to now + 24h or `PLAN_APPROVAL_TTL_MS`. */
  expiresAt?: string;
  steps: NewRemediationPlanStep[];
}

export interface RemediationPlanPatch {
  status?: RemediationPlanStatus;
  autoEdit?: boolean;
  approvalRequestId?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
}

export interface RemediationPlanStepPatch {
  status?: RemediationPlanStepStatus;
  approvalRequestId?: string | null;
  executedAt?: string | null;
  outputText?: string | null;
  errorText?: string | null;
}

export interface ListRemediationPlansOptions {
  status?: RemediationPlanStatus | RemediationPlanStatus[];
  investigationId?: string;
  rescueForPlanId?: string | null;
  limit?: number;
  offset?: number;
}

export interface IRemediationPlanRepository {
  /** Insert plan + steps atomically. Returns the persisted plan with steps populated. */
  create(input: NewRemediationPlan): Promise<RemediationPlan>;

  /** Lookup a plan + its steps. NULL if not found or not in the org. */
  findByIdInOrg(orgId: string, id: string): Promise<RemediationPlan | null>;

  listByOrg(orgId: string, opts?: ListRemediationPlansOptions): Promise<RemediationPlan[]>;

  /** Update plan-level fields. Steps are not touched. */
  updatePlan(orgId: string, id: string, patch: RemediationPlanPatch): Promise<RemediationPlan | null>;

  /** Update one step by (planId, ordinal). */
  updateStep(
    planId: string,
    ordinal: number,
    patch: RemediationPlanStepPatch,
  ): Promise<RemediationPlanStep | null>;

  /** Delete a plan + its steps. Returns true iff a row was deleted. */
  delete(orgId: string, id: string): Promise<boolean>;

  /**
   * Mark all `pending_approval` plans whose `expires_at` has passed as
   * `expired`. Returns the number of plans transitioned. Idempotent.
   */
  expireStale(now: string): Promise<number>;
}
