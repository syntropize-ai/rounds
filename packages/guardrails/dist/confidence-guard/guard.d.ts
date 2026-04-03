import type { Hypothesis, Evidence } from '@agentic-obs/common';
import type { ConfidenceAdjustment, ConfidenceGuardConfig } from './types.js';
export declare class ConfidenceGuard {
    private readonly config;
    private readonly rules;
    constructor(config?: Partial<ConfidenceGuardConfig>);
    /**
     * Evaluate all rules against a hypothesis and its evidence.
     * Returns only the adjustments that fired (non-null results).
     */
    evaluate(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment[];
    /**
     * Apply all rules to a batch of hypotheses, adjusting confidence in-place
     * (returns new hypothesis objects; originals are not mutated).
     */
    applyToHypotheses(hypotheses: Hypothesis[], evidenceMap: Map<string, Evidence[]>): Hypothesis[];
    private buildRules;
}
//# sourceMappingURL=guard.d.ts.map