import type { Hypothesis, InvestigationPlan, InvestigationStep, StructuredIntent } from '@agentic-obs/common';
import type { SystemContext } from '../context/types.js';
export type StepType = 'compare_latency_vs_baseline' | 'check_error_rate' | 'inspect_downstream' | 'correlate_deployments' | 'sample_traces' | 'cluster_logs' | 'check_saturation' | 'check_traffic_pattern' | 'check_slo_burn_rate' | 'check_error_distribution';
export interface ReplayableQuery {
    query: string;
    queryLanguage: string;
    adapterName?: string;
    params?: Record<string, string>;
}
export interface StepFinding {
    stepType: StepType;
    summary: string;
    value?: number;
    baseline?: number;
    deviationRatio?: number;
    isAnomaly: boolean;
    rawData?: unknown;
    replayableQuery?: ReplayableQuery;
}
export interface InvestigationInput {
    intent: StructuredIntent;
    context: SystemContext;
}
export interface InvestigationOutput {
    plan: InvestigationPlan;
    hypotheses: Hypothesis[];
    findings: StepFinding[];
    stopReason: StopReason;
}
export type StopReason = 'high_confidence_hypothesis' | 'max_cost' | 'time_budget' | 'all_steps_complete';
export interface InvestigationConfig {
    highConfidenceThreshold?: number;
    timeBudgetMs?: number;
    maxQueries?: number;
    skipSteps?: StepType[];
}
export type { InvestigationStep, Hypothesis };
//# sourceMappingURL=types.d.ts.map