// Execution adapter types - local definitions to avoid circular dependency with agent-core

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
