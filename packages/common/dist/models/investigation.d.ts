import type { Hypothesis } from './hypothesis.js';
import type { Action } from './action.js';
import type { Evidence } from './evidence.js';
import type { Symptom } from './symptom.js';
import type { StructuredIntent } from './intent.js';
export type InvestigationStatus = 'planning' | 'investigating' | 'evidencing' | 'explaining' | 'acting' | 'verifying' | 'completed' | 'failed';
export interface InvestigationStepCost {
    tokens: number;
    queries: number;
    latencyMs: number;
}
export interface InvestigationStep {
    id: string;
    type: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    result?: unknown;
    cost?: InvestigationStepCost;
}
export interface StopCondition {
    type: 'high_confidence_hypothesis' | 'max_cost' | 'max_queries' | 'time_budget';
    params: Record<string, number>;
}
export interface InvestigationPlan {
    entity: string;
    objective: string;
    steps: InvestigationStep[];
    stopConditions: StopCondition[];
}
export interface Investigation {
    id: string;
    sessionId: string;
    userId: string;
    intent: string;
    structuredIntent: StructuredIntent;
    plan: InvestigationPlan;
    status: InvestigationStatus;
    hypotheses: Hypothesis[];
    actions: Action[];
    evidence: Evidence[];
    symptoms: Symptom[];
    createdAt: string;
    updatedAt: string;
}
//# sourceMappingURL=investigation.d.ts.map