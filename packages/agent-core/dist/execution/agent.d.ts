import type { ActionRule, ExecutionInput, ExecutionOutput } from './types.js';
/**
 * @deprecated Rule-based fallback only. LLMExecutionAgent (execution-agent.ts) is the primary
 * execution path. This class should not be used for new integrations.
 */
export declare class ExecutionAgent {
    readonly name = "execution";
    private readonly rules;
    private readonly maxActions;
    constructor(options?: {
        rules?: ActionRule[];
        maxActions?: number;
    });
    propose(input: ExecutionInput): Promise<ExecutionOutput>;
    private buildSummary;
}
//# sourceMappingURL=agent.d.ts.map