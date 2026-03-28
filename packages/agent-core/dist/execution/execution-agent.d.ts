import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ActionGuard, CredentialResolver } from '@agentic-obs/guardrails';
import type { AdapterRegistry } from './adapter-registry.js';
import type { ExecutionResult } from './types.js';
import type { ExecutionContext, ExecutionPlan, PlannedAction, GuardedPlan,
    ResultEvaluation, InvestigationConclusion } from './execution-agent-types.js';

export interface ExecutionAgentConfig {
    llm: LLMGateway;
    adapterRegistry: AdapterRegistry;
    actionGuard: ActionGuard;
    /** Optional credential resolver - required to execute actions with a credentialRef */
    credentialResolver?: CredentialResolver;
    model?: string;
    temperature?: number;
}

interface AuditEntry {
    timestamp: string;
    investigationId: string;
    actionType: string;
    targetService: string;
    /** The credentialRef used (never the resolved value) */
    credentialRef?: string;
    result: 'success' | 'failed';
    executionId: string;
    error?: string;
}

export declare class LLMExecutionAgent {
    private readonly llm;
    private readonly adapterRegistry;
    private readonly actionGuard;
    private readonly credentialResolver?;
    private readonly model;
    private readonly temperature;
    private readonly auditTrail;
    private readonly AUDIT_MAX_SIZE;
    constructor(config: ExecutionAgentConfig);
    /**
     * LLM evaluates the investigation conclusion and produces an execution plan
     * with specific adapter actions, risk levels, and reasoning.
     */
    plan(conclusion: InvestigationConclusion, context: ExecutionContext): Promise<ExecutionPlan>;
    /**
     * Evaluates each planned action through the ActionGuard and categorizes them
     * into approved / needsApproval / denied buckets.
     */
    guard(plan: ExecutionPlan): Promise<GuardedPlan>;
    /**
     * Executes a single planned action via the adapter pipeline:
     * credential-bind → validate → dryRun → execute.
     * Records an audit trail entry for every execution attempt.
     *
     * Credentials are resolved immediately before the pipeline and discarded
     * after execution - they are never stored in the audit trail or returned.
     */
    execute(action: PlannedAction, context?: ExecutionContext): Promise<ExecutionResult>;
    /**
     * LLM evaluates the execution result against the original context and returns
     * an outcome assessment with next steps and rollback recommendation.
     */
    evaluateResult(result: ExecutionResult, context: ExecutionContext): Promise<ResultEvaluation>;
    getAuditTrail(): AuditEntry[];
    private buildPlanPrompt;
    private buildEvaluationPrompt;
    private parsePlanResponse;
    private parseEvaluationResponse;
    private recordAudit;
}

export {};
//# sourceMappingURL=execution-agent.d.ts.map