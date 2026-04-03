import type { StructuredConclusion } from '../explanation/types.js';
import type { AdapterAction } from './types.js';
export type InvestigationConclusion = StructuredConclusion;
export interface ExecutionContext {
    investigationId: string;
    conclusion: InvestigationConclusion;
    symptoms: string[];
    services: string[];
}
export interface PlannedAction {
    /** The concrete adapter action to execute */
    action: AdapterAction;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    reasoning: string;
    /** 1 = highest priority */
    priority: number;
}
export interface ExecutionPlan {
    actions: PlannedAction[];
    /** LLM's overall reasoning for the plan */
    reasoning: string;
}
export interface GuardedPlan {
    approved: PlannedAction[];
    needsApproval: PlannedAction[];
    denied: PlannedAction[];
}
export interface ResultEvaluation {
    outcome: 'success' | 'partial' | 'failed' | 'pending_llm';
    nextSteps: string[];
    shouldRollback: boolean;
    reasoning: string;
}
//# sourceMappingURL=execution-agent-types.d.ts.map