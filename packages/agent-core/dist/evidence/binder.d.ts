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
    minRelevance?: number;
}
export interface BoundEvidence {
    evidence: Evidence;
    isSupporting: boolean;
    confidenceDelta: number;
}
export declare function bindFindingsToHypothesis(hypothesis: Hypothesis, findings: StepFinding[], timestamp: string, options?: BindingOptions): BoundEvidence[];
export declare function clampConfidence(value: number): number;
export declare function deriveStatus(confidence: number, supportCount: number, counterCount: number): Hypothesis['status'];
//# sourceMappingURL=binder.d.ts.map