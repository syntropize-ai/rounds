import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ActionGuard } from '@agentic-obs/guardrails';
import type { AdapterRegistry } from '../execution/adapter-registry.js';
import type { VerificationLoop } from '../execution/verification-loop.js';
import type { RunbookDefinition, RunbookResult } from './types.js';

export interface RunbookEngineConfig {
    llm: LLMGateway;
    adapterRegistry: AdapterRegistry;
    actionGuard: ActionGuard;
    model?: string;
    temperature?: number;
    /** Verification loop for post-step checks. Created automatically if not provided. */
    verificationLoop?: VerificationLoop;
}

export declare class RunbookEngine {
    private readonly llm;
    private readonly adapterRegistry;
    private readonly actionGuard;
    private readonly verificationLoop;
    private readonly model;
    private readonly temperature;
    constructor(config: RunbookEngineConfig);
    /**
     * Execute a runbook.
     * The LLM decides whether to proceed with each step, and handles failures
     * by choosing retry/skip/abort/alternate. No step order is hard-coded.
     */
    execute(runbook: RunbookDefinition, context?: Record<string, unknown>): Promise<RunbookResult>;
    private executeStep;
    private executeWithRetry;
    private runAdapterStep;
    /**
     * Ask the LLM: "Should I proceed with this step, given current runbook state?"
     * LLM can return: proceed | skip | abort
     */
    private askShouldProceed;
    /** Ask the LLM: "Step X failed - should I retry, skip, abort, or try alternate?" */
    private askHowToHandleFailure;
    private generateSummary;
    private buildProceedPrompt;
    private buildFailurePrompt;
    private parseProceedDecision;
    private parseFailureDecision;
}
//# sourceMappingURL=runbook-engine.d.ts.map
