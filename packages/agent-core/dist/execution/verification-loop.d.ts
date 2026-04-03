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
    verify(executionResult: ExecutionResult, preExecutionMetrics: MetricSnapshot, postExecutionMetrics: MetricSnapshot): Promise<VerificationOutcome>;
    private buildVerificationPrompt;
    private parseVerificationResponse;
}
//# sourceMappingURL=verification-loop.d.ts.map