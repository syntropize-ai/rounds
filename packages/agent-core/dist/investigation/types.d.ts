import type { StructuredIntent, Hypothesis, InvestigationPlan, InvestigationStep } from '@agentic-obs/common';
import type { SystemContext } from '../context/types.js';

export type StepType = 'compare_latency_vs_baseline' | 'check_error_rate' | 'inspect_downstream' | 'correlate_deployments' | 'sample_traces' | 'cluster_logs' | 'check_saturation' | 'check_slo_burn_rate' | 'check_error_distribution' | 'check_traffic_pattern';

export interface ReplayableQuery {
    /** The actual query string executed (e.g. PromQL expression or semantic metric key) */
    query: string;
    /** Query language identifier (e.g. promql, semantic) */
    queryLanguage: string;
    /** Name of the adapter that executed the query (e.g. prometheus) */
    adapterName: string;
    /** Additional parameters needed to replay the query (entity, time range, etc.) */
    params?: Record<string, unknown>;
}

export interface StepFinding {
    stepType: StepType;
    /** Human-readable summary of what was found */
    summary: string;
    /** Numeric value if the step produced a measurement (e.g. p95 latency) */
    value?: number;
    /** Baseline value for comparison steps */
    baseline?: number;
    /** Relative deviation from baseline (positive = worse) */
    deviationRatio?: number;
    /** Whether this finding is anomalous / noteworthy */
    isAnomaly: boolean;
    /** Raw data from the metrics adapter query */
    rawData?: unknown;
    /** The actual query executed, enabling evidence replay; absent when no real query ran */
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
    /** Confidence threshold that triggers early stop (default: 0.85) */
    highConfidenceThreshold?: number;
    /** Max wall-clock time for the full investigation in ms (default: 60_000) */
    timeBudgetMs?: number;
    /** Max number of data-source queries (default: 50) */
    maxQueries?: number;
    /** Steps to skip entirely */
    skipSteps?: StepType[];
}

export type { InvestigationStep, Hypothesis };
//# sourceMappingURL=types.d.ts.map
