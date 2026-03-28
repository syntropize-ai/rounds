/**
 * Evidence Binder - maps StepFindings to hypotheses as supporting or counter evidence.
 *
 * Rule-based approach: each step type has known semantic relevance to hypothesis types.
 * A finding is "supporting" when it confirms the hypothesis direction (anomaly present),
 * and "counter" when it argues against it (no anomaly found).
 */
import type { Evidence, Hypothesis } from '@agentic-obs/common';
import type { StepFinding } from '../investigation/types.js';

export interface BindingOptions {
    /** Minimum relevance score to create an evidence item (default: 0.2) */
    minRelevance?: number;
}

export interface BoundEvidence {
    evidence: Evidence;
    isSupporting: boolean;
    confidenceDelta: number;
}

/**
 * Bind a list of step findings to a hypothesis.
 * Returns evidence items that are relevant to the hypothesis, along with
 * whether each piece is supporting or counter, and the confidence delta.
 */
export declare function bindFindingsToHypothesis(
    hypothesis: Hypothesis,
    findings: StepFinding[],
    timestamp: string,
    options?: BindingOptions
): BoundEvidence[];

/**
 * Clamp a confidence value to [0, 1].
 */
export declare function clampConfidence(value: number): number;

/**
 * Derive hypothesis status from updated confidence and evidence pattern.
 */
export declare function deriveStatus(confidence: number, supportCount: number, counterCount: number): Hypothesis['status'];
//# sourceMappingURL=binder.d.ts.map