import { randomUUID } from 'node:crypto';
import { LLMUnavailableError } from '@agentic-obs/common';
export class LLMExecutionAgent {
    llm;
    adapterRegistry;
    actionGuard;
    credentialResolver;
    model;
    temperature;
    auditTrail = [];
    AUDIT_MAX_SIZE = 10_000;
    constructor(config) {
        this.llm = config.llm;
        this.adapterRegistry = config.adapterRegistry;
        this.actionGuard = config.actionGuard;
        this.credentialResolver = config.credentialResolver;
        this.model = config.model ?? 'claude-sonnet-4-6';
        this.temperature = config.temperature ?? 0.1;
    }
    async plan(conclusion, context) {
        let raw;
        try {
            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: 'You are an expert SRE execution planner. Given an investigation conclusion, recommend specific, targeted remediation actions. Always respond with valid JSON matching the required schema.',
                },
                { role: 'user', content: this.buildPlanPrompt(conclusion, context) },
            ], {
                model: this.model,
                temperature: this.temperature,
                maxTokens: 2048,
                responseFormat: 'json',
            });
            raw = response.content;
        }
        catch {
            return { actions: [], reasoning: 'LLM unavailable - no actions planned' };
        }
        return this.parsePlanResponse(raw);
    }
    async guard(plan) {
        const approved = [];
        const needsApproval = [];
        const denied = [];
        for (const plannedAction of plan.actions) {
            const actionInput = {
                type: plannedAction.action.type,
                targetService: plannedAction.action.targetService,
                params: plannedAction.action.params,
            };
            const decision = this.actionGuard.evaluate(actionInput);
            if (decision.effect === 'allow')
                approved.push(plannedAction);
            else if (decision.effect === 'require_approval')
                needsApproval.push(plannedAction);
            else
                denied.push(plannedAction);
        }
        return { approved, needsApproval, denied };
    }
    async execute(action, context) {
        const adapters = this.adapterRegistry.getByCapability(action.action.type);
        const executionId = randomUUID();
        if (adapters.length === 0) {
            const result = {
                success: false,
                output: null,
                rollbackable: false,
                executionId,
                error: `No adapter found for action type: ${action.action.type}`,
            };
            this.recordAudit(action, result, context?.investigationId);
            return result;
        }
        const adapter = adapters[0];
        let boundAction = action.action;
        if (action.action.credentialRef) {
            const ref = action.action.credentialRef;
            if (!this.credentialResolver) {
                const result = {
                    success: false,
                    output: null,
                    rollbackable: false,
                    executionId,
                    error: `Action requires credential '${ref}' but no CredentialResolver is configured`,
                };
                this.recordAudit(action, result);
                return result;
            }
            let resolved;
            try {
                const cred = await this.credentialResolver.resolve(ref);
                resolved = cred?.value;
            }
            catch (err) {
                const result = {
                    success: false,
                    output: null,
                    rollbackable: false,
                    executionId,
                    error: `Failed to resolve credential '${ref}': ${err instanceof Error ? err.message : String(err)}`,
                };
                this.recordAudit(action, result);
                return result;
            }
            if (resolved === undefined) {
                const result = {
                    success: false,
                    output: null,
                    rollbackable: false,
                    executionId,
                    error: `Credential '${ref}' could not be resolved - action aborted`,
                };
                this.recordAudit(action, result);
                return result;
            }
            boundAction = { ...action.action, resolvedCredential: resolved };
        }
        let validation;
        try {
            validation = await adapter.validate(boundAction);
        }
        catch (err) {
            const result = {
                success: false,
                output: null,
                rollbackable: false,
                executionId,
                error: `Validation threw: ${err instanceof Error ? err.message : String(err)}`,
            };
            this.recordAudit(action, result, context?.investigationId);
            return result;
        }
        if (!validation.valid) {
            const result = {
                success: false,
                output: null,
                rollbackable: false,
                executionId,
                error: `Validation failed: ${validation.reason}`,
            };
            this.recordAudit(action, result, context?.investigationId);
            return result;
        }
        try {
            const dryRun = await adapter.dryRun(boundAction);
            if (dryRun.warnings.length > 0) {
                console.warn('[ExecutionAgent] dryRun warnings:', dryRun.warnings);
            }
        }
        catch (err) {
            console.warn('[ExecutionAgent] dryRun failed (proceeding):', err);
        }
        let result;
        try {
            result = await adapter.execute(boundAction);
        }
        catch (err) {
            result = {
                success: false,
                output: null,
                rollbackable: false,
                executionId,
                error: `Execute threw: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (boundAction !== action.action) {
            boundAction.resolvedCredential = undefined;
        }
        this.recordAudit(action, result);
        return result;
    }
    async evaluateResult(result, context) {
        let raw;
        try {
            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: 'You are an SRE expert evaluating the outcome of a remediation action. Determine if it succeeded, suggest next steps, and whether rollback is needed. Always respond with valid JSON matching the required schema.',
                },
                { role: 'user', content: this.buildEvaluationPrompt(result, context) },
            ], {
                model: this.model,
                temperature: this.temperature,
                maxTokens: 1024,
                responseFormat: 'json',
            });
            raw = response.content;
        }
        catch {
            throw new LLMUnavailableError();
        }
        return this.parseEvaluationResponse(raw, result);
    }
    getAuditTrail() {
        return [...this.auditTrail];
    }
    buildPlanPrompt(conclusion, context) {
        const topHypothesis = conclusion.hypotheses[0];
        return JSON.stringify({
            instruction: 'Based on this investigation conclusion, recommend specific remediation actions. For each action specify: type, target service, parameters, risk level, and reasoning.',
            investigationId: context.investigationId,
            symptoms: context.symptoms,
            affectedServices: context.services,
            conclusion: {
                summary: conclusion.summary,
                topHypothesis: topHypothesis
                    ? {
                        description: topHypothesis.hypothesis.description,
                        confidence: topHypothesis.hypothesis.confidence,
                        evidenceSummary: topHypothesis.evidenceSummary,
                    }
                    : null,
                impact: conclusion.impact,
                existingRecommendations: conclusion.recommendedActions.map((r) => ({
                    type: r.action.type,
                    description: r.action.description,
                    rationale: r.rationale,
                })),
            },
            responseSchema: {
                actions: [{
                        action: {
                            type: 'string - adapter capability e.g. k8s:scale, k8s:restart, k8s:rollback, slack:notify',
                            targetService: 'string',
                            params: 'object with adapter-specific parameters',
                            credentialRef: 'optional string',
                        },
                        riskLevel: 'low | medium | high | critical',
                        reasoning: 'string explaining why this action addresses the root cause',
                        priority: 'number - 1 is highest priority',
                    }],
                reasoning: 'string - overall plan reasoning',
            },
        });
    }
    buildEvaluationPrompt(result, context) {
        return JSON.stringify({
            instruction: 'Evaluate the execution result of a remediation action. Determine the outcome, suggest concrete next steps, and whether rollback is needed.',
            investigationId: context.investigationId,
            symptoms: context.symptoms,
            affectedServices: context.services,
            executionResult: {
                success: result.success,
                output: result.output,
                rollbackable: result.rollbackable,
                error: result.error ?? null,
            },
            responseSchema: {
                outcome: 'success | partial | failed',
                nextSteps: ['array of concrete next-step strings'],
                shouldRollback: 'boolean',
                reasoning: 'string',
            },
        });
    }
    parsePlanResponse(raw) {
        let parsed;
        try {
            parsed = JSON.parse(stripCodeFences(raw));
        }
        catch {
            return { actions: [], reasoning: 'LLM response could not be parsed' };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { actions: [], reasoning: 'LLM returned invalid response shape' };
        }
        const obj = parsed;
        const rawActions = Array.isArray(obj.actions) ? obj.actions : [];
        const actions = rawActions
            .filter((a) => typeof a === 'object' && a !== null)
            .map((a) => {
            const x = a;
            const actionObj = typeof x.action === 'object' && x.action !== null ? x.action : {};
            const adapterAction = {
                type: String(actionObj.type ?? 'unknown'),
                targetService: String(actionObj.targetService ?? ''),
                params: typeof actionObj.params === 'object' && actionObj.params !== null ? actionObj.params : {},
                credentialRef: actionObj.credentialRef != null ? String(actionObj.credentialRef) : undefined,
            };
            return {
                action: adapterAction,
                riskLevel: isRiskLevel(x.riskLevel) ? x.riskLevel : 'medium',
                reasoning: String(x.reasoning ?? ''),
                priority: typeof x.priority === 'number' ? x.priority : 99,
            };
        });
        return {
            actions,
            reasoning: String(obj.reasoning ?? ''),
        };
    }
    parseEvaluationResponse(raw, result) {
        let parsed;
        try {
            parsed = JSON.parse(stripCodeFences(raw));
        }
        catch {
            throw new Error('LLM returned non-JSON content for evaluation');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('LLM returned invalid response shape for evaluation');
        }
        const obj = parsed;
        const outcomeRaw = obj.outcome;
        const outcome = outcomeRaw === 'success' || outcomeRaw === 'partial' || outcomeRaw === 'failed'
            ? outcomeRaw
            : 'pending_llm';
        return {
            outcome,
            nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps.map(String) : [],
            shouldRollback: typeof obj.shouldRollback === 'boolean' ? obj.shouldRollback : false,
            reasoning: String(obj.reasoning ?? ''),
        };
    }
    recordAudit(action, result, investigationId = '') {
        this.auditTrail.push({
            timestamp: new Date().toISOString(),
            investigationId,
            actionType: action.action.type,
            targetService: action.action.targetService,
            credentialRef: action.action.credentialRef,
            result: result.success ? 'success' : 'failed',
            executionId: result.executionId,
            error: result.error,
        });
        if (this.auditTrail.length > this.AUDIT_MAX_SIZE) {
            this.auditTrail.shift();
        }
    }
}
function stripCodeFences(raw) {
    const trimmed = raw.trim();
    const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    return match?.[1]?.trim() ?? trimmed;
}
function isRiskLevel(v) {
    return v === 'low' || v === 'medium' || v === 'high' || v === 'critical';
}
//# sourceMappingURL=execution-agent.js.map