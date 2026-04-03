import type { Hypothesis, Evidence, Action, Symptom } from '@agentic-obs/common';
/**
 * Target audience for the generated explanation narrative.
 *
 * - `sre`       = on-call engineer; full technical detail, PromQL refs, step-by-step actions
 * - `em`        = engineering manager; impact + timeline + team actions, minimal jargon
 * - `executive` = business stakeholder; user/revenue impact, plain English, no technical detail
 */
export type ExplanationAudience = 'sre' | 'em' | 'executive';
export interface ExplanationInput {
    /** Hypotheses with their current confidence and status */
    hypotheses: Hypothesis[];
    /** Evidence items keyed by hypothesis ID */
    evidenceMap: Map<string, Evidence[]>;
    /** Observed symptoms that triggered the investigation */
    symptoms: Symptom[];
    /** Investigation context */
    context: {
        entity: string;
        timeRange: {
            start: string;
            end: string;
        };
    };
    /**
     * Target audience for the generated narrative.
     * Defaults to `sre` when omitted.
     */
    audience?: ExplanationAudience;
}
export interface RankedHypothesis {
    hypothesis: Hypothesis;
    /** Rank: smaller means more likely */
    rank: number;
    /** Concise paragraph-level plain-English summary of supporting and counter evidence */
    evidenceSummary: string;
    /** Why this confidence score was assigned */
    confidenceExplanation: string;
}
export interface ImpactAssessment {
    severity: 'low' | 'medium' | 'high' | 'critical';
    affectedServices: string[];
    /** Human-readable estimate, e.g. "~15% of checkout users" */
    affectedUsers: string;
    description: string;
}
export interface RecommendedAction {
    action: Action;
    /** Why this action addresses the root cause */
    rationale: string;
    /** What improvement is expected if the action succeeds */
    expectedOutcome: string;
    /** Known risks or side-effects */
    risk: string;
}
export interface StructuredConclusion {
    /** One-paragraph narrative summary for SRE consumption */
    summary: string;
    /** Hypotheses ranked by confidence (higher first) */
    hypotheses: RankedHypothesis[];
    impact: ImpactAssessment;
    recommendedActions: RecommendedAction[];
    /** Known risks not covered by recommended actions */
    risks: string[];
    /** Signals or evidence areas not yet investigated */
    uncoveredAreas: string[];
    generatedAt: string;
}
export declare class ExplanationParseError extends Error {
    readonly rawContent: string;
    constructor(message: string, rawContent: string);
}
//# sourceMappingURL=types.d.ts.map