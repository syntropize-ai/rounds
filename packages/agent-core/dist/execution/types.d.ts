import type { Hypothesis, Evidence, Action } from '@agentic-obs/common';
import type { StructuredConclusion } from '../explanation/types.js';
/**
 * A concrete action the LLM has decided to execute.
 * Carries everything an adapter needs to run the operation.
 */
export interface AdapterAction {
    /** Adapter-scoped operation, e.g. 'k8s:scale', 'slack:notify', 'jira:create' */
    type: string;
    /** Adapter-specific parameters */
    params: Record<string, unknown>;
    /** The service / resource being targeted */
    targetService: string;
    /** Optional reference to a stored credential; resolved by CredentialResolver */
    credentialRef?: string;
    /**
     * The resolved credential value - populated by ExecutionAgent immediately
     * before calling adapter methods, then discarded after execution.
     * Adapters may read this value; they must NOT store or log it.
     */
    resolvedCredential?: string;
}
/** Result returned by `validate()` */
export interface ValidationResult {
    valid: boolean;
    /** Reason for invalidity; omitted when `valid` is true */
    reason?: string;
}
/** Result returned by `execute()` */
export interface ExecutionResult {
    success: boolean;
    /** Adapter-specific output */
    output: unknown;
    /** Whether the adapter can undo this operation via `rollback()` */
    rollbackable: boolean;
    /** Stable ID used to reference this execution in `rollback()` calls */
    executionId: string;
    /** Human-readable error message when `success` is false */
    error?: string;
}
/** Result returned by `dryRun()` - no side-effects */
export interface DryRunResult {
    /** Human-readable summary of expected impact */
    estimatedImpact: string;
    /** Warnings the operator should review before proceeding */
    warnings: string[];
    /** List of services / resources that would be mutated */
    willAffect: string[];
}
/** Capability token an adapter may advertise */
export type AdapterCapability = string;
/**
 * Contract every concrete execution adapter must implement.
 *
 * The LLM is the decision-maker ("brain"); adapters are the effectors ("hands").
 * Adapters do NOT make decisions - they only carry out what the LLM decided.
 */
export interface ExecutionAdapter {
    /** Returns the list of `AdapterAction.type` values this adapter handles */
    capabilities(): AdapterCapability[];
    /** Validates action params; no side-effects. */
    validate(action: AdapterAction): Promise<ValidationResult>;
    /** Simulates the operation; must never produce real side-effects. */
    dryRun(action: AdapterAction): Promise<DryRunResult>;
    /**
     * Executes the operation for real.
     * Should be idempotent: retrying the same `executionId` must not duplicate side-effects.
     */
    execute(action: AdapterAction): Promise<ExecutionResult>;
    /**
     * Optional: undo a previously executed action identified by `executionId`.
     * Adapters that cannot roll back may omit this method.
     */
    rollback?(action: AdapterAction, executionId: string): Promise<ExecutionResult>;
}
export interface ExecutionInput {
    conclusion: StructuredConclusion;
    context: {
        entity: string;
        environment?: string;
    };
}
export interface ExecutionOutput {
    /** Suggested actions - none auto-execute in Phase 0 */
    actions: Action[];
    /** Human-readable summary of all proposed actions */
    summary: string;
}
/** A rule that matches hypotheses and produces a candidate action */
export interface ActionRule {
    name: string;
    /** Returns true if this rule applies to the given hypothesis */
    matches(hypothesis: Hypothesis, evidence: Evidence[]): boolean;
    /** Build the action for a matching hypothesis */
    buildAction(hypothesis: Hypothesis, evidence: Evidence[], entity: string): Action;
    /** Human-readable rationale embedded in action description */
    rationale(hypothesis: Hypothesis): string;
}
//# sourceMappingURL=types.d.ts.map
