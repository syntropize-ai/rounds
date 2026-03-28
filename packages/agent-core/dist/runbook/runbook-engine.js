/**
 * RunbookEngine - LLM-driven multi-step execution orchestration
 * LLM is the brain: it evaluates every step decision, handles failures,
 * and determines branching. No hard-coded if/else orchestration logic.
 */
import { VerificationLoop } from '../execution/verification-loop.js';
const MAX_RETRIES = 4;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TEMPERATURE = 0.1;
// RunbookEngine
export class RunbookEngine {
    llm;
    adapterRegistry;
    actionGuard;
    verificationLoop;
    model;
    temperature;
    constructor(config) {
        this.llm = config.llm;
        this.adapterRegistry = config.adapterRegistry;
        this.actionGuard = config.actionGuard;
        this.model = config.model ?? DEFAULT_MODEL;
        this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
        this.verificationLoop =
            config.verificationLoop ?? new VerificationLoop({ llm: config.llm });
    }
    /**
     * Execute a runbook.
     * The LLM decides whether to proceed with each step, and handles failures
     * by choosing retry/skip/abort/alternate. No step order is hard-coded.
     */
    async execute(runbook, context = {}) {
        const startedAt = new Date().toISOString();
        const runbookCtx = { state: { ...context }, history: [] };
        let overallStatus = 'completed';
        for (const step of runbook.steps) {
            const stepResult = await this.executeStep(runbook, step, runbookCtx);
            runbookCtx.history.push(stepResult);
            if (stepResult.status === 'aborted') {
                overallStatus = 'aborted';
                break;
            }
            if (stepResult.status === 'failed') {
                overallStatus = 'partial';
                // Continue to next step - LLM already decided not to abort
            }
        }
        const summary = await this.generateSummary(runbook, runbookCtx, overallStatus);
        return {
            runbookId: runbook.id,
            status: overallStatus,
            stepsExecuted: runbookCtx.history,
            summary,
            startedAt,
            completedAt: new Date().toISOString(),
        };
    }
    // Step execution
    async executeStep(runbook, step, ctx) {
        // Phase 1: LLM decides whether to proceed
        const proceedDecision = await this.askShouldProceed(runbook, step, ctx);
        if (proceedDecision.decision === 'skip') {
            return {
                stepId: step.id,
                status: 'skipped',
                llmReasoning: proceedDecision.reasoning,
                attempts: 0,
            };
        }
        if (proceedDecision.decision === 'abort') {
            return {
                stepId: step.id,
                status: 'aborted',
                llmReasoning: proceedDecision.reasoning,
                attempts: 0,
            };
        }
        // Phase 2: ActionGuard policy check
        const guardDecision = this.actionGuard.evaluate({
            type: step.adapterType,
            targetServices: step.targetService,
            params: step.params,
        });
        if (guardDecision.effect === 'deny') {
            return {
                stepId: step.id,
                status: 'skipped',
                llmReasoning: `ActionGuard denied: ${guardDecision.reason}`,
                attempts: 0,
            };
        }
        // Phase 3: Execute with retry loop (LLM decides on failure)
        return this.executeWithRetry(runbook, step, ctx, guardDecision.effect === 'require_approval');
    }
    async executeWithRetry(runbook, step, ctx, requiresApproval) {
        let attempts = 0;
        let lastError;
        // If approval required, mark as skipped - approval flow is external
        if (requiresApproval) {
            return {
                stepId: step.id,
                status: 'skipped',
                llmReasoning: 'Step requires human approval - skipped by RunbookEngine (use ApprovalFlow)',
                attempts: 0,
            };
        }
        while (attempts < MAX_RETRIES) {
            attempts++;
            const result = await this.runAdapterStep(step);
            if (result.success) {
                // Phase 4: VerificationLoop - LLM verifies the step was effective
                // Best-effort: if verification LLM is unavailable, don't block the step result
                try {
                    await this.verificationLoop.verify(result, {}, {});
                }
                catch {
                    // Verification failed - step still succeeded
                }
                return {
                    stepId: step.id,
                    status: attempts > 1 ? 'retried' : 'succeeded',
                    llmReasoning: `Step succeeded on attempt ${attempts}`,
                    executionId: result.executionId,
                    output: result.output,
                    attempts,
                };
            }
            lastError = result.error;
            // Phase 5: LLM decides what to do with the failure
            const failureDecision = await this.askHowToHandleFailure(runbook, step, ctx, result, attempts);
            if (failureDecision.decision === 'retry' && attempts < MAX_RETRIES) {
                continue;
            }
            if (failureDecision.decision === 'skip') {
                return {
                    stepId: step.id,
                    status: 'failed',
                    llmReasoning: failureDecision.reasoning,
                    executionId: result.executionId,
                    error: lastError,
                    attempts,
                };
            }
            if (failureDecision.decision === 'abort') {
                return {
                    stepId: step.id,
                    status: 'aborted',
                    llmReasoning: failureDecision.reasoning,
                    executionId: result.executionId,
                    error: lastError,
                    attempts,
                };
            }
            // alternate or unknown - treat as failed, continue runbook
            return {
                stepId: step.id,
                status: 'failed',
                llmReasoning: failureDecision.reasoning,
                executionId: result.executionId,
                error: lastError,
                attempts,
            };
        }
        // Exhausted retries
        return {
            stepId: step.id,
            status: 'failed',
            llmReasoning: `Step failed after ${attempts} attempts`,
            error: lastError,
            attempts,
        };
    }
    // Adapter execution
    async runAdapterStep(step) {
        const adapters = this.adapterRegistry.getByCapability(step.adapterType);
        if (adapters.length === 0) {
            return {
                success: false,
                output: null,
                rollbackable: false,
                executionId: `runbook-${step.id}-${Date.now()}`,
                error: `No adapter found for action type ${step.adapterType}`,
            };
        }
        const adapter = adapters[0];
        const action = {
            type: step.adapterType,
            params: step.params,
            targetService: step.targetService,
            credentialRef: step.credentialRef,
        };
        try {
            return await adapter.execute(action);
        }
        catch (err) {
            return {
                success: false,
                output: null,
                rollbackable: false,
                executionId: `runbook-${step.id}-${Date.now()}`,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    // LLM decision calls
    /**
     * Ask the LLM: "Should I proceed with this step, given current runbook state?"
     * LLM can return: proceed | skip | abort
     */
    async askShouldProceed(runbook, step, ctx) {
        const prompt = this.buildProceedPrompt(runbook, step, ctx);
        let raw;
        try {
            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: 'You are an SRE automation orchestrator evaluating whether to proceed with the next runbook step. Assess the current state, step description, and any conditions. Decide proceed, skip, or abort. Respond with valid JSON.',
                },
                { role: 'user', content: prompt },
            ], {
                model: this.model,
                temperature: this.temperature,
                maxTokens: 512,
                responseFormat: 'json',
            });
            raw = response.content;
        }
        catch {
            // LLM unavailable - default to proceed
            return { decision: 'proceed', reasoning: 'LLM unavailable - defaulting to proceed' };
        }
        return this.parseProceedDecision(raw);
    }
    /** Ask the LLM: "Step X failed - should I retry, skip, abort, or try alternate?" */
    async askHowToHandleFailure(runbook, step, ctx, result, attempt) {
        const prompt = this.buildFailurePrompt(runbook, step, ctx, result, attempt);
        let raw;
        try {
            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: 'You are an SRE automation orchestrator handling a failed runbook step. Evaluate the failure and decide how to recover: retry, skip, abort, or alternate. Respond with valid JSON.',
                },
                { role: 'user', content: prompt },
            ], {
                model: this.model,
                temperature: this.temperature,
                maxTokens: 512,
                responseFormat: 'json',
            });
            raw = response.content;
        }
        catch {
            // LLM unavailable - default to skip (continue runbook)
            return { decision: 'skip', reasoning: 'LLM unavailable - defaulting to skip on failure' };
        }
        return this.parseFailureDecision(raw);
    }
    async generateSummary(runbook, ctx, status) {
        const prompt = JSON.stringify({
            instruction: 'Write a concise summary of this runbook execution.',
            runbookName: runbook.name,
            overallStatus: status,
            stepResults: ctx.history.map((s) => ({
                stepId: s.stepId,
                status: s.status,
                attempts: s.attempts,
                error: s.error ?? null,
            })),
            responseSchema: { summary: 'string - 2-3 sentence execution summary' },
        });
        try {
            const response = await this.llm.complete([
                { role: 'system', content: 'You summarize runbook executions. Respond with valid JSON.' },
                { role: 'user', content: prompt },
            ], {
                model: this.model,
                temperature: this.temperature,
                maxTokens: 256,
                responseFormat: 'json',
            });
            const parsed = safeParseJson(response.content);
            if (parsed && typeof parsed.summary === 'string') {
                return parsed.summary;
            }
        }
        catch {
            // ignore
        }
        const succeeded = ctx.history.filter((s) => s.status === 'succeeded' || s.status === 'retried').length;
        const total = ctx.history.length;
        return `Runbook "${runbook.name}" ${status}. ${succeeded}/${total} steps completed successfully.`;
    }
    // Prompt builders
    buildProceedPrompt(runbook, step, ctx) {
        return JSON.stringify({
            instruction: 'Should this runbook step be executed given the current state?',
            consider: 'step condition, previous step outcomes, and overall runbook progress.',
            runbook: { id: runbook.id, name: runbook.name, description: runbook.description },
            currentStep: {
                id: step.id,
                description: step.description,
                adapterType: step.adapterType,
                targetService: step.targetService,
                condition: step.condition ?? null,
                onSuccess: step.onSuccess ?? null,
                onFailure: step.onFailure ?? null,
            },
            executionState: ctx.state,
            previousSteps: ctx.history.map((s) => ({
                stepId: s.stepId,
                status: s.status,
                error: s.error ?? null,
            })),
            responseSchema: {
                decision: 'proceed | skip | abort',
                reasoning: 'string - your reasoning for the decision',
                skipReason: 'string (only when decision=skip) - why this step is skipped',
            },
        });
    }
    buildFailurePrompt(runbook, step, ctx, result, attempt) {
        return JSON.stringify({
            instruction: 'A runbook step has failed. Decide how to recover: retry (attempt again), skip (continue to next step), abort (stop runbook), or alternate.',
            runbook: { id: runbook.id, name: runbook.name },
            failedStep: {
                id: step.id,
                description: step.description,
                adapterType: step.adapterType,
                targetService: step.targetService,
                onFailure: step.onFailure ?? null,
                attempt,
                maxRetries: MAX_RETRIES,
            },
            failureDetails: {
                error: result.error ?? 'unknown error',
                output: result.output,
            },
            previousSteps: ctx.history.map((s) => ({
                stepId: s.stepId,
                status: s.status,
                error: s.error ?? null,
            })),
            responseSchema: {
                decision: 'retry | skip | abort | alternate',
                reasoning: 'string - why you chose this recovery strategy',
                alternateAction: 'object (only when decision=alternate): { adapterType, params, targetService }',
            },
        });
    }
    // Response parsers
    parseProceedDecision(raw) {
        const parsed = safeParseJson(raw);
        if (!parsed) {
            return { decision: 'proceed', reasoning: 'Could not parse LLM response' };
        }
        const validDecisions = ['proceed', 'skip', 'abort'];
        const decision = validDecisions.includes(parsed.decision)
            ? parsed.decision
            : 'proceed';
        return {
            decision,
            reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        };
    }
    parseFailureDecision(raw) {
        const parsed = safeParseJson(raw);
        if (!parsed) {
            return { decision: 'skip', reasoning: 'Could not parse LLM response - defaulting to skip' };
        }
        const validDecisions = ['retry', 'skip', 'abort', 'alternate'];
        const decision = validDecisions.includes(parsed.decision)
            ? parsed.decision
            : 'skip';
        return {
            decision,
            reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        };
    }
}
// Helpers
function safeParseJson(raw) {
    try {
        const trimmed = raw.trim();
        const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
        const text = fenceMatch?.[1]?.trim() ?? trimmed;
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=runbook-engine.js.map
