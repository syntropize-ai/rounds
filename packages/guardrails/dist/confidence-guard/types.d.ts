import type { Hypothesis } from '@agentic-obs/common';
import type { Evidence } from '@agentic-obs/common';
export type { Hypothesis, Evidence };
export interface ConfidenceAdjustment {
    adjustedConfidence: number;
    reason: string;
    severity: 'info' | 'warning' | 'critical';
}
export interface ConfidenceRule {
    name: string;
    check(hypothesis: Hypothesis, evidence: Evidence[]): ConfidenceAdjustment | null;
}
export interface ConfidenceGuardConfig {
    /** Minimum number of evidence items required for full confidence. Default: 2 */
    minEvidenceCount: number;
    /** Maximum allowed confidence when counter-evidence has not been checked. Default: 0.7 */
    maxConfidenceWithoutCounterCheck: number;
    /** Confidence penalty applied when all evidence comes from a single source type. Default: 0.3 */
    singleSourcePenalty: number;
}
export declare const DEFAULT_CONFIG: ConfidenceGuardConfig;
//# sourceMappingURL=types.d.ts.map