import type { ActionRule, ExecutionInput, ExecutionOutput } from './types.js';

export interface ExecutionAgentOptions {
    /** Override the default rule set */
    rules?: ActionRule[];
    /**
     * Max actions to generate per investigation (default: 5).
     * Prevents overwhelming the operator with too many suggestions.
     */
    maxActions?: number;
}

/**
 * @deprecated Rule-based fallback only. LLMExecutionAgent (execution-agent.ts) is the primary
 * execution path. This class should not be used for new integrations.
 */
export declare class ExecutionAgent {
    readonly name = "execution";
    private readonly rules;
    private readonly maxActions;
    constructor(options?: ExecutionAgentOptions);
    /**
     * Generate recommended actions from a StructuredConclusion.
     *
     * Phase 0 safety contract:
     * - All actions: status = 'proposed', never auto-execute.
     * - policyTag is set per rule: 'suggest' or 'approve_required' - never 'deny'.
     * - Refuted hypotheses produce no actions.
     * - Action types deduplicated (highest-confidence hypothesis wins).
     */
    propose(input: ExecutionInput): Promise<ExecutionOutput>;
    private buildSummary;
}
//# sourceMappingURL=agent.d.ts.map