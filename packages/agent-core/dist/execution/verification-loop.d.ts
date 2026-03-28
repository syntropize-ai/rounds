import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ExecutionResult } from './types.js';
export interface VerificationOutcome {
    outcome: 'resolved' | 'improved' | 'unchanged' | 'degraded';
    reasoning: string;
    shouldRollback: boolean;
    nextSteps: string[];
}
export interface MetricSnapshot {
    [key: string]: number | string | boolean | null | undefined;
}
export declare class VerificationLoop {
    private readonly llm;
    private readonly observationWindowMs;
    constructor(config: {
        llm: LLMGateway;
        observationWindowMs?: number;
    });
    /**
     * LLM compares pre/post execution metrics to determine if the action was effective.
     * Throws LLMUnavailableError if the LLM call fails or returns unparseable output.
     * Callers should surface "AI unavailable - please verify manually" to the user.
     */
    verify(executionResult: ExecutionResult, preExecutionMetrics: MetricSnapshot,
        postExecutionMetrics: MetricSnapshot): Promise<VerificationOutcome>;
    private buildVerificationPrompt;
    private parseVerificationResponse;
}
//# sourceMappingURL=verification-loop.d.ts.map
