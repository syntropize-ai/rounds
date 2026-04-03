import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ActionGuard, CredentialResolver } from '@agentic-obs/guardrails';
import type { AdapterRegistry } from './adapter-registry.js';
import type { ExecutionResult } from './types.js';
import type { ExecutionContext, ExecutionPlan, PlannedAction, GuardedPlan, ResultEvaluation, InvestigationConclusion } from './execution-agent-types.js';
export interface ExecutionAgentConfig {
    llm: LLMGateway;
    adapterRegistry: AdapterRegistry;
    actionGuard: ActionGuard;
    credentialResolver?: CredentialResolver;
    model?: string;
    temperature?: number;
}
interface AuditEntry {
    timestamp: string;
    investigationId: string;
    actionType: string;
    targetService: string;
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
    plan(conclusion: InvestigationConclusion, context: ExecutionContext): Promise<ExecutionPlan>;
    guard(plan: ExecutionPlan): Promise<GuardedPlan>;
    execute(action: PlannedAction, context?: ExecutionContext): Promise<ExecutionResult>;
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