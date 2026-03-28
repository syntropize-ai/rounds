// Execution Agent types - rule-based recommended action generation

import type { Hypothesis, Evidence, Action } from '@agentic-obs/common';
import type { StructuredConclusion } from '../explanation/types.js';

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

export interface ValidationResult {
  valid: boolean;
  /** Reason for invalidity; omitted when `valid` is true */
  reason?: string;
}

export interface ExecutionResult {
  success: boolean;
  output: unknown;
  rollbackable: boolean;
  executionId: string;
  error?: string;
}

export interface DryRunResult {
  estimatedImpact: string;
  warnings: string[];
  willAffect: string[];
}

export type AdapterCapability = string;

export interface ExecutionAdapter {
  capabilities(): AdapterCapability[];
  validate(action: AdapterAction): Promise<ValidationResult>;
  dryRun(action: AdapterAction): Promise<DryRunResult>;
  execute(action: AdapterAction): Promise<ExecutionResult>;
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

export interface ActionRule {
  name: string;
  matches(hypothesis: Hypothesis, evidence: Evidence[]): boolean;
  buildAction(hypothesis: Hypothesis, evidence: Evidence[], entity: string): Action;
  rationale(hypothesis: Hypothesis): string;
}
