/**
 * DriftDetector - statistical comparison of benchmark scores against a
 * rolling historical baseline to surface model degradation.
 *
 * Usage:
 *   const detector = new DriftDetector();
 *   detector.record(previousScore); // call once per historical run
 *   const alerts = detector.detect(currentScore);
 */
import type { BenchmarkScore, CaseBaseline, DriftAlert, DriftReport } from './types.js';
export interface DriftDetectorConfig {
    /**
     * Maximum number of historical runs retained per case (default: 30).
     * Older runs are evicted in FIFO order.
     */
    historySize?: number;
    /**
     * Drop in score that triggers a WARNING alert (default: 0.10 = 10 pp).
     */
    warningThreshold?: number;
    /**
     * Drop in score that triggers a CRITICAL alert (default: 0.20 = 20 pp).
     */
    criticalThreshold?: number;
    /**
     * Minimum number of historical samples required before drift detection
     * is meaningful (default: 3). Below this, detection is skipped.
     */
    minSamples?: number;
}
export declare class DriftDetector {
    private readonly cfg;
    /** Historical scores per caseId, stored in insertion order (oldest first). */
    private readonly history;
    constructor(config?: DriftDetectorConfig);
    /** Record a historical benchmark score to build the baseline. */
    record(score: BenchmarkScore): void;
    /**
     * Compute the historical baseline for a case.
     * Returns null when there are fewer than minSamples recorded.
     */
    computeBaseline(caseId: string): CaseBaseline | null;
    /**
     * Detect drift for a single score by comparing it to the recorded baseline.
     * Returns an empty array when:
     * - no baseline is available (too few samples), or
     * - all metrics are within acceptable thresholds.
     */
    detect(score: BenchmarkScore): DriftAlert[];
    /**
     * Generate a full DriftReport from a set of current scores.
     * Each score is compared against its baseline; alerts are aggregated.
     * The report passes when no CRITICAL alerts are present.
     */
    generateReport(scores: BenchmarkScore[]): DriftReport;
    /** Return the raw history buffer for a case (useful in tests). */
    getHistory(caseId: string): BenchmarkScore[];
    /** Number of cases tracked. */
    get trackedCaseCount(): number;
}
//# sourceMappingURL=drift-detector.d.ts.map
