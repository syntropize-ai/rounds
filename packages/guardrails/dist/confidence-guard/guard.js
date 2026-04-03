import { DEFAULT_CONFIG } from './types.js';
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export class ConfidenceGuard {
    config;
    rules;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.rules = this.buildRules();
    }
    /**
     * Evaluate all rules against a hypothesis and its evidence.
     * Returns only the adjustments that fired (non-null results).
     */
    evaluate(hypothesis, evidence) {
        const adjustments = [];
        for (const rule of this.rules) {
            const result = rule.check(hypothesis, evidence);
            if (result !== null) {
                adjustments.push(result);
            }
        }
        return adjustments;
    }
    /**
     * Apply all rules to a batch of hypotheses, adjusting confidence in-place
     * (returns new hypothesis objects; originals are not mutated).
     */
    applyToHypotheses(hypotheses, evidenceMap) {
        return hypotheses.map(hypothesis => {
            const evidence = evidenceMap.get(hypothesis.id) ?? [];
            const adjustments = this.evaluate(hypothesis, evidence);
            if (adjustments.length === 0) {
                return hypothesis;
            }
            // Apply the most restrictive adjustment (lowest adjustedConfidence)
            const minAdjusted = adjustments.reduce((min, adj) => (adj.adjustedConfidence < min ? adj.adjustedConfidence : min), hypothesis.confidence);
            const finalConfidence = clamp(minAdjusted, 0, 1);
            const worstAdjustment = adjustments.find(a => a.adjustedConfidence === minAdjusted) ?? adjustments[0];
            return {
                ...hypothesis,
                confidence: finalConfidence,
                confidenceBasis: worstAdjustment.reason,
            };
        });
    }
    buildRules() {
        const { minEvidenceCount, maxConfidenceWithoutCounterCheck, singleSourcePenalty } = this.config;
        return [
            // Rule A: insufficient evidence count
            {
                name: 'insufficient-evidence',
                check(hypothesis, evidence) {
                    if (evidence.length < minEvidenceCount) {
                        const adjustedConfidence = Math.min(hypothesis.confidence, 0.5);
                        return {
                            adjustedConfidence,
                            reason: `证据数量不足（${evidence.length}/${minEvidenceCount}），置信度上限 0.5`,
                            severity: 'warning',
                        };
                    }
                    return null;
                },
            },
            // Rule B: no counter-evidence checked
            {
                name: 'no-counter-evidence',
                check(hypothesis, evidence) {
                    if (hypothesis.counterEvidenceIds.length === 0) {
                        const adjustedConfidence = Math.min(hypothesis.confidence, maxConfidenceWithoutCounterCheck);
                        if (adjustedConfidence < hypothesis.confidence) {
                            return {
                                adjustedConfidence,
                                reason: `缺少反证校验，置信度上限 ${maxConfidenceWithoutCounterCheck}`,
                                severity: 'warning',
                            };
                        }
                    }
                    return null;
                },
            },
            // Rule C: all evidence from a single source type
            {
                name: 'single-source-type',
                check(hypothesis, evidence) {
                    if (evidence.length === 0)
                        return null;
                    const types = new Set(evidence.map(e => e.type));
                    if (types.size === 1) {
                        const adjustedConfidence = clamp(hypothesis.confidence - singleSourcePenalty, 0, 1);
                        return {
                            adjustedConfidence,
                            reason: `所有证据来自单一数据源类型（${[...types][0]}），降低置信度 ${singleSourcePenalty}`,
                            severity: 'warning',
                        };
                    }
                    return null;
                },
            },
            // Rule D: high confidence with too little evidence
            {
                name: 'high-confidence-low-evidence',
                check(hypothesis, evidence) {
                    if (hypothesis.confidence > 0.9 && evidence.length < 3) {
                        return {
                            adjustedConfidence: 0.7,
                            reason: `置信度 ${hypothesis.confidence} 过高但证据仅 ${evidence.length} 条（< 3），强降为 0.7`,
                            severity: 'critical',
                        };
                    }
                    return null;
                },
            },
        ];
    }
}
//# sourceMappingURL=guard.js.map