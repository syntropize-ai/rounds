/**
 * DriftDetector - statistical comparison of benchmark scores against a
 * rolling historical baseline to surface model degradation.
 *
 * Usage:
 *   const detector = new DriftDetector();
 *   detector.record(previousScore); // call once per historical run
 *   const alerts = detector.detect(currentScore);
 */
const DEFAULTS = {
    historySize: 30,
    warningThreshold: 0.10,
    criticalThreshold: 0.20,
    minSamples: 3,
};
const SCORED_METRICS = [
    'intentAccuracy',
    'hypothesisKeywordRate',
    'conclusionCompleteness',
    'overallScore',
];
// Detector
export class DriftDetector {
    cfg;
    /** Historical scores per caseId, stored in insertion order (oldest first). */
    history = new Map();
    constructor(config = {}) {
        this.cfg = { ...DEFAULTS, ...config };
    }
    // Ingestion
    /** Record a historical benchmark score to build the baseline. */
    record(score) {
        const buf = this.history.get(score.caseId) ?? [];
        buf.push(score);
        if (buf.length > this.cfg.historySize) {
            buf.splice(0, buf.length - this.cfg.historySize);
        }
        this.history.set(score.caseId, buf);
    }
    // Baseline
    /**
     * Compute the historical baseline for a case.
     * Returns null when there are fewer than minSamples recorded.
     */
    computeBaseline(caseId) {
        const buf = this.history.get(caseId) ?? [];
        if (buf.length < this.cfg.minSamples) {
            return null;
        }
        return {
            caseId,
            sampleCount: buf.length,
            meanIntentAccuracy: mean(buf.map((s) => s.intentAccuracy)),
            meanHypothesisKeywordRate: mean(buf.map((s) => s.hypothesisKeywordRate)),
            meanConclusionCompleteness: mean(buf.map((s) => s.conclusionCompleteness)),
            meanOverallScore: mean(buf.map((s) => s.overallScore)),
        };
    }
    // Detection
    /**
     * Detect drift for a single score by comparing it to the recorded baseline.
     * Returns an empty array when:
     * - no baseline is available (too few samples), or
     * - all metrics are within acceptable thresholds.
     */
    detect(score) {
        const baseline = this.computeBaseline(score.caseId);
        if (!baseline) {
            return [];
        }
        const alerts = [];
        const metricMap = {
            intentAccuracy: {
                current: score.intentAccuracy,
                baseline: baseline.meanIntentAccuracy,
            },
            hypothesisKeywordRate: {
                current: score.hypothesisKeywordRate,
                baseline: baseline.meanHypothesisKeywordRate,
            },
            conclusionCompleteness: {
                current: score.conclusionCompleteness,
                baseline: baseline.meanConclusionCompleteness,
            },
            overallScore: {
                current: score.overallScore,
                baseline: baseline.meanOverallScore,
            },
        };
        for (const metric of SCORED_METRICS) {
            const { current, baseline: base } = metricMap[metric];
            const delta = current - base;
            // Only alert on degradation (not on improvements)
            if (delta >= -this.cfg.warningThreshold) {
                continue;
            }
            const severity = delta <= -this.cfg.criticalThreshold ? 'critical' : 'warning';
            alerts.push({
                caseId: score.caseId,
                metric,
                currentValue: current,
                baselineValue: base,
                delta,
                severity,
                message: `[${severity.toUpperCase()}] case=${score.caseId} metric=${metric} degraded by ${Math.abs(delta * 100).toFixed(1)} pp (current=${(current * 100).toFixed(1)}%, baseline=${(base * 100).toFixed(1)}%)`,
            });
        }
        return alerts;
    }
    // Report
    /**
     * Generate a full DriftReport from a set of current scores.
     * Each score is compared against its baseline; alerts are aggregated.
     * The report passes when no CRITICAL alerts are present.
     */
    generateReport(scores) {
        const allAlerts = [];
        for (const score of scores) {
            allAlerts.push(...this.detect(score));
        }
        const hasCritical = allAlerts.some((a) => a.severity === 'critical');
        return {
            runAt: new Date().toISOString(),
            scores,
            alerts: allAlerts,
            passed: !hasCritical,
        };
    }
    /** Return the raw history buffer for a case (useful in tests). */
    getHistory(caseId) {
        return this.history.get(caseId) ?? [];
    }
    /** Number of cases tracked. */
    get trackedCaseCount() {
        return this.history.size;
    }
}
// Statistical helpers
function mean(values) {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}
//# sourceMappingURL=drift-detector.js.map
