import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DEFAULT_ORCHESTRATOR_CONFIG } from './types.js';
// - Main orchestrator ------------------------------------------------------
export class AgentOrchestrator extends EventEmitter {
    intentAgent;
    contextAgent;
    investigationAgent;
    evidenceAgent;
    config;
    constructor(deps) {
        super();
        this.intentAgent = deps.intentAgent;
        this.contextAgent = deps.contextAgent;
        this.investigationAgent = deps.investigationAgent;
        this.evidenceAgent = deps.evidenceAgent;
        this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...(deps.config ?? {}) };
    }
    // - Public API -----------------------------------------------------------
    async run(input) {
        const investigationId = randomUUID();
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        const agentCtx = {
            investigationId,
            tenantId: input.tenantId,
            userId: input.userId,
        };
        let globalTimer;
        const timeoutPromise = new Promise((_, reject) => {
            globalTimer = setTimeout(() => reject(new Error('Total orchestration timeout exceeded')), this.config.totalTimeoutMs);
        });
        try {
            const result = await Promise.race([
                this.pipeline(input, investigationId, agentCtx, startedAt, startMs),
                timeoutPromise,
            ]);
            return result;
        }
        catch (err) {
            const completedAt = new Date().toISOString();
            this.emitEvent({
                type: 'error',
                state: 'failed',
                investigationId,
                error: err instanceof Error ? err.message : String(err),
                fatal: true,
            });
            return {
                investigationId,
                sessionId: input.sessionId,
                state: 'failed',
                intent: null,
                context: null,
                hypotheses: [],
                evidence: [],
                explanation: null,
                coverage: {
                    covered: [],
                    uncovered: ['intent', 'context', 'investigation', 'evidence', 'explanation'],
                    degradedSteps: [],
                },
                startedAt,
                completedAt,
                durationMs: Date.now() - startMs,
            };
        }
        finally {
            clearTimeout(globalTimer);
        }
    }
    // - Pipeline -------------------------------------------------------------
    async pipeline(input, investigationId, agentCtx, startedAt, startMs) {
        let state = 'planning';
        const covered = [];
        const uncovered = [];
        const degradedSteps = [];
        this.transitionTo(investigationId, 'planning', 'planning', state);
        // - Step 1: planning - parse intent
        let intent = null;
        const intentStart = Date.now();
        try {
            intent = await this.withTimeout(this.intentAgent.parse({ message: input.message, sessionId: input.sessionId }), this.config.stepTimeoutMs, 'IntentAgent timed out');
            covered.push('intent');
            this.emitStep(state, investigationId, Date.now() - intentStart, false);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emitDegraded(state, investigationId, `Intent parsing failed: ${msg}`, covered, ['intent', 'context', 'investigation', 'evidence', 'explanation']);
            this.emitEvent({ type: 'error', state, investigationId, error: msg, fatal: true });
            if (!this.config.degradeOnError)
                throw err;
            uncovered.push('intent', 'context', 'investigation', 'evidence', 'explanation');
            degradedSteps.push('intent');
            return this.buildOutput(investigationId, input.sessionId, 'failed', intent, null, [], [], null, { covered, uncovered, degradedSteps }, startedAt, startMs);
        }
        // - Step 2: investigating - collect context + run investigation
        state = this.transitionTo(investigationId, state, 'investigating');
        let context = null;
        const contextStart = Date.now();
        try {
            const ctxResult = await this.withTimeout(this.contextAgent.run(intent, agentCtx), this.config.stepTimeoutMs, 'ContextAgent timed out');
            if (ctxResult?.success && ctxResult.data) {
                context = ctxResult.data;
                covered.push('context');
            }
            else {
                throw new Error(ctxResult?.error ?? 'ContextAgent returned no data');
            }
            this.emitStep(state, investigationId, Date.now() - contextStart, false);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emitDegraded(state, investigationId, `Context unavailable: ${msg}`, covered, ['context']);
            if (!this.config.degradeOnError)
                throw err;
            uncovered.push('context');
            degradedSteps.push('context');
            this.emitStep(state, investigationId, Date.now() - contextStart, true);
            // Continue with null context - InvestigationAgent has its own fallback
            context = {
                entity: intent.entity,
                topology: { node: null, dependencies: [], dependents: [] },
                recentChanges: [],
                sloStatus: [],
                historicalIncidents: [],
                collectedAt: new Date().toISOString(),
            };
        }
        let investigationOutput = null;
        if (context !== null) {
            const invStart = Date.now();
            try {
                const invResult = await this.withTimeout(this.investigationAgent.run({ intent, context }, agentCtx), this.config.stepTimeoutMs, 'InvestigationAgent timed out');
                if (invResult?.success && invResult.data) {
                    investigationOutput = invResult.data;
                    covered.push('investigation');
                }
                else {
                    throw new Error(invResult?.error ?? 'InvestigationAgent returned no data');
                }
                this.emitStep(state, investigationId, Date.now() - invStart, false);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.emitDegraded(state, investigationId, `Investigation failed: ${msg}`, covered, ['investigation']);
                if (!this.config.degradeOnError)
                    throw err;
                uncovered.push('investigation');
                degradedSteps.push('investigation');
                this.emitStep(state, investigationId, Date.now() - invStart, true);
            }
        }
        else {
            uncovered.push('investigation');
        }
        // - Step 3: evidencing - bind evidence to hypotheses
        state = this.transitionTo(investigationId, state, 'evidencing');
        let evidenceOutput = null;
        if (investigationOutput !== null) {
            const evStart = Date.now();
            try {
                const evResult = await this.withTimeout(this.evidenceAgent.run({
                    hypotheses: investigationOutput.hypotheses,
                    findings: investigationOutput.findings,
                    entity: intent.entity,
                    timeRange: intent.timeRange,
                }, agentCtx), this.config.stepTimeoutMs, 'EvidenceAgent timed out');
                if (evResult.success && evResult.data) {
                    evidenceOutput = evResult.data;
                    covered.push('evidence');
                }
                else {
                    throw new Error(evResult.error ?? 'EvidenceAgent returned no data');
                }
                this.emitStep(state, investigationId, Date.now() - evStart, false);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.emitDegraded(state, investigationId, `Evidence binding failed: ${msg}`, covered, ['evidence']);
                if (!this.config.degradeOnError)
                    throw err;
                uncovered.push('evidence');
                degradedSteps.push('evidence');
                this.emitStep(state, investigationId, Date.now() - evStart, true);
            }
        }
        else {
            uncovered.push('evidence');
        }
        const hypotheses = evidenceOutput?.hypotheses ?? investigationOutput?.hypotheses ?? [];
        const evidence = evidenceOutput?.evidence ?? [];
        // - Step 4: explaining - generate structured conclusion
        state = this.transitionTo(investigationId, state, 'explaining');
        const explanation = this.buildExplanation(hypotheses, uncovered);
        if (uncovered.length === 0 || !uncovered.includes('investigation')) {
            covered.push('explanation');
        }
        else {
            uncovered.push('explanation');
        }
        // - Step 5: verifying - completed
        state = this.transitionTo(investigationId, state, 'verifying');
        state = this.transitionTo(investigationId, state, 'completed');
        return this.buildOutput(investigationId, input.sessionId, state, intent, context, hypotheses, evidence, explanation, { covered, uncovered, degradedSteps }, startedAt, startMs);
    }
    // - Explanation placeholder ----------------------------------------------
    buildExplanation(hypotheses, uncovered) {
        const best = [...hypotheses].sort((a, b) => b.confidence - a.confidence)[0];
        if (!best) {
            return {
                summary: uncovered.length > 0
                    ? `Investigation incomplete - uncovered steps: ${uncovered.join(', ')}`
                    : 'No hypotheses generated.',
                rootCause: null,
                confidence: 0,
                recommendedActions: [],
            };
        }
        const degradedNote = uncovered.length > 0
            ? ` However, ${uncovered.join(', ')} unavailable - conclusion may be incomplete.`
            : '';
        return {
            summary: `${best.description}${degradedNote}`,
            rootCause: best.status === 'supported' || best.confidence >= 0.7 ? best.description : null,
            confidence: best.confidence,
            recommendedActions: best.status === 'supported'
                ? ['Review the identified root cause', 'Apply recommended remediation']
                : ['Gather more evidence', 'Expand investigation scope'],
        };
    }
    // - Helpers --------------------------------------------------------------
    buildOutput(investigationId, sessionId, state, intent, context, hypotheses, evidence, explanation, coverage, startedAt, startMs) {
        return {
            investigationId,
            sessionId,
            state,
            intent,
            context,
            hypotheses,
            evidence,
            explanation,
            coverage,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
        };
    }
    transitionTo(investigationId, from, to, prev) {
        this.transition(investigationId, from, to, prev);
        return to;
    }
    transition(investigationId, from, to, _prev) {
        this.emitEvent({
            type: 'state_transition',
            from,
            to,
            investigationId,
            timestampMs: Date.now(),
        });
    }
    emitStep(state, investigationId, durationMs, degraded) {
        this.emitEvent({ type: 'step_complete', state, investigationId, durationMs, degraded });
    }
    emitDegraded(state, investigationId, reason, coveredBy, uncovered) {
        this.emitEvent({ type: 'degraded', state, investigationId, reason, coveredBy, uncovered });
        this.emitEvent({
            type: 'error',
            state,
            investigationId,
            error: reason,
            fatal: false,
        });
    }
    emitEvent(event) {
        this.emit('orchestrator', event);
    }
    withTimeout(promise, ms, message) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }
}
//# sourceMappingURL=orchestrator.js.map