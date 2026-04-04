import type { Hypothesis, Evidence } from '@agentic-obs/common';
import type { ConfidenceAdjustment, ConfidenceRule, ConfidenceGuardConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class ConfidenceGuard {
  private readonly config: ConfidenceGuardConfig;
  private readonly rules: ConfidenceRule[];

  constructor(config: Partial<ConfidenceGuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rules = this.buildRules();
  }

  /**
   * Evaluate all rules against a hypothesis and its evidence.
   * Returns only the adjustments that fired (non-null results).
   */
  evaluate(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment[] {
    const adjustments: ConfidenceAdjustment[] = [];
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
  applyToHypotheses(
    hypotheses: Hypothesis[],
    evidenceMap: Map<string, Evidence[]>,
  ): Hypothesis[] {
    return hypotheses.map(hypothesis => {
      const evidence = evidenceMap.get(hypothesis.id) ?? [];
      const adjustments = this.evaluate(hypothesis, evidence);

      if (adjustments.length === 0) {
        return hypothesis;
      }

      // Apply the most restrictive adjustment (lowest adjustedConfidence)
      const minAdjusted = adjustments.reduce(
        (min, adj) => (adj.adjustedConfidence < min ? adj.adjustedConfidence : min),
        hypothesis.confidence,
      );

      const finalConfidence = clamp(minAdjusted, 0, 1);
      const worstAdjustment =
        adjustments.find(a => a.adjustedConfidence === minAdjusted) ?? adjustments[0]!;

      return {
        ...hypothesis,
        confidence: finalConfidence,
        confidenceBasis: worstAdjustment.reason,
      };
    });
  }

  private buildRules(): ConfidenceRule[] {
    const { minEvidenceCount, maxConfidenceWithoutCounterCheck, singleSourcePenalty } = this.config;

    return [
      // Rule A: insufficient evidence count
      {
        name: 'insufficient-evidence',
        check(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment | null {
          if (evidence.length < minEvidenceCount) {
            const adjustedConfidence = Math.min(hypothesis.confidence, 0.5);
            return {
              adjustedConfidence,
              reason: `Insufficient evidence (${evidence.length}/${minEvidenceCount}), confidence capped at 0.5`,
              severity: 'warning',
            };
          }
          return null;
        },
      },

      // Rule B: no counter-evidence checked
      {
        name: 'no-counter-evidence',
        check(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment | null {
          if (hypothesis.counterEvidenceIds.length === 0) {
            const adjustedConfidence = Math.min(hypothesis.confidence, maxConfidenceWithoutCounterCheck);
            if (adjustedConfidence < hypothesis.confidence) {
              return {
                adjustedConfidence,
                reason: `Missing counter-evidence check, confidence capped at ${maxConfidenceWithoutCounterCheck}`,
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
        check(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment | null {
          if (evidence.length === 0) return null;
          const types = new Set(evidence.map(e => e.type));
          if (types.size === 1) {
            const adjustedConfidence = clamp(hypothesis.confidence - singleSourcePenalty, 0, 1);
            return {
              adjustedConfidence,
              reason: `All evidence from single source type (${[...types][0]}), confidence reduced by ${singleSourcePenalty}`,
              severity: 'warning',
            };
          }
          return null;
        },
      },

      // Rule D: high confidence with too little evidence
      {
        name: 'high-confidence-low-evidence',
        check(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment | null {
          if (hypothesis.confidence > 0.9 && evidence.length < 3) {
            return {
              adjustedConfidence: 0.7,
              reason: `Confidence ${hypothesis.confidence} too high with only ${evidence.length} evidence items (< 3), forced down to 0.7`,
              severity: 'critical',
            };
          }
          return null;
        },
      },
    ];
  }
}
