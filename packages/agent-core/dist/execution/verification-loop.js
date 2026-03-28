import { LLMUnavailableError } from '@agentic-obs/common';
export class VerificationLoop {
    llm;
    observationWindowMs;
    constructor(config) {
        this.llm = config.llm;
        this.observationWindowMs = config.observationWindowMs ?? 300_000;
    }
    /**
     * LLM compares pre/post execution metrics to determine if the action was effective.
     * Throws LLMUnavailableError if the LLM call fails or returns unparseable output.
     * Callers should surface "AI unavailable - please verify manually" to the user.
     */
    async verify(executionResult, preExecutionMetrics, postExecutionMetrics) {
        let raw;
        try {
            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: 'You are an SRE expert verifying whether a remediation action resolved an incident. ' +
                        'Compare pre and post execution metrics and determine if the action was effective. ' +
                        'Always respond with valid JSON matching the required schema.',
                },
                {
                    role: 'user',
                    content: this.buildVerificationPrompt(executionResult, preExecutionMetrics, postExecutionMetrics),
                },
            ], {
                model: 'claude-sonnet-4-6',
                temperature: 0.1,
                maxTokens: 1024,
                responseFormat: 'json',
            });
            raw = response.content;
        }
        catch (err) {
            throw new LLMUnavailableError(err instanceof Error ? err.message : 'LLM verification failed');
        }
        return this.parseVerificationResponse(raw, executionResult);
    }
    buildVerificationPrompt(executionResult, preMetrics, postMetrics) {
        return JSON.stringify({
            instruction: 'Compare pre and post execution metrics. Was the action effective? ' +
                `Observation window: ${this.observationWindowMs}ms.`,
            executionResult: {
                success: executionResult.success,
                output: executionResult.output,
                error: executionResult.error ?? null,
            },
            preExecutionMetrics: preMetrics,
            postExecutionMetrics: postMetrics,
            responseSchema: {
                outcome: 'resolved | improved | unchanged | degraded',
                reasoning: 'string - explanation comparing pre/post metrics',
                shouldRollback: 'boolean - true if metrics worsened and rollback is warranted',
                nextSteps: ['array of concrete follow-up action strings'],
            },
        });
    }
    parseVerificationResponse(raw, executionResult) {
        let parsed;
        try {
            const trimmed = raw.trim();
            const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
            parsed = JSON.parse(fenceMatch?.[1]?.trim() ?? trimmed);
        }
        catch {
            throw new LLMUnavailableError('LLM returned unparseable verification response');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new LLMUnavailableError('LLM returned invalid verification response structure');
        }
        const obj = parsed;
        const outcomeRaw = obj.outcome;
        const validOutcomes = ['resolved', 'improved', 'unchanged', 'degraded'];
        const outcome = typeof outcomeRaw === 'string' &&
            validOutcomes.includes(outcomeRaw)
            ? outcomeRaw
            : executionResult.success
                ? 'improved'
                : 'unchanged';
        return {
            outcome,
            reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
            shouldRollback: typeof obj.shouldRollback === 'boolean'
                ? obj.shouldRollback
                : outcome === 'degraded' && executionResult.rollbackable,
            nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps.map(String) : [],
        };
    }
}
//# sourceMappingURL=verification-loop.js.map
