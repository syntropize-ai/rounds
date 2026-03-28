/** A single step in a runbook */
export interface RunbookStep {
    /** Unique step identifier */
    id: string;
    /** Human-readable description - used as LLM context */
    description: string;
    /** Adapter action type to invoke (e.g. "k8s_restart") */
    adapterType: string;
    /** Adapter-specific parameters */
    params: Record<string, unknown>;
    /** Target service/resource */
    targetService: string;
    /** Optional credentialRef for adapter execution */
    credentialRef?: string;
    /** On-success hint - LLM uses this as guidance (not hard rule) */
    onSuccess?: string;
    /** On-failure hint - LLM uses this as guidance (not hard rule) */
    onFailure?: string;
    /** Natural language condition - LLM evaluates whether to run this step */
    condition?: string;
}

/** Top-level runbook definition */
export interface RunbookDefinition {
    id: string;
    name: string;
    description: string;
    steps: RunbookStep[];
    /** Optional triggers (informational - used by schedulers, not RunbookEngine) */
    triggers?: string[];
}

/** How the LLM decided to handle a step */
export type StepDecision = 'proceed' | 'skip' | 'retry' | 'abort' | 'alternate';

/** Status of a single step after execution */
export type StepStatus = 'skipped' | 'succeeded' | 'failed' | 'retried' | 'aborted';

/** Per-step execution record */
export interface StepResult {
    stepId: string;
    status: StepStatus;
    /** LLM reasoning for the proceed/skip/retry/abort/alternate decision */
    llmReasoning?: string;
    executionId?: string;
    output?: unknown;
    error?: string;
    attempts: number;
}

/** Final outcome of a RunbookEngine.execute() call */
export type RunbookStatus = 'completed' | 'partial' | 'aborted' | 'failed';

export interface RunbookResult {
    runbookId: string;
    status: RunbookStatus;
    stepsExecuted: StepResult[];
    /** LLM-generated overall summary */
    summary: string;
    startedAt: string;
    completedAt: string;
}

/** Context available throughout runbook execution */
export interface RunbookContext {
    /** Arbitrary key-value state accumulated across steps */
    state: Record<string, unknown>;
    /** Ordered history of step results for LLM context */
    history: StepResult[];
}
//# sourceMappingURL=types.d.ts.map
