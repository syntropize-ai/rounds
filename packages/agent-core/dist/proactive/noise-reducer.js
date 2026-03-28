// Types
// NoiseReducer
export class NoiseReducer {
    llmEvaluator;
    dismissThreshold;
    dismissals = [];
    totalEvaluated = 0;
    constructor(config = {}) {
        this.llmEvaluator = config.llmEvaluator;
        this.dismissThreshold = config.dismissThreshold ?? 0.3;
    }
    /**
     * Evaluate a finding and decide whether to keep, downgrade, or suppress it.
     *
     * Without an LLM evaluator, all findings are kept (no hardcoded filtering).
     * With an LLM evaluator:
     * - confidence >= dismissThreshold                 -> keep
     * - confidence in [dismissThreshold/2, dismissThreshold) -> downgrade
     * - confidence < dismissThreshold/2                -> suppress
     */
    async evaluate(finding) {
        this.totalEvaluated++;
        if (!this.llmEvaluator) {
            return {
                action: 'keep',
                assessment: {
                    confidence: 1,
                    reasoning: 'No LLM evaluator configured; keeping all findings by default.',
                    suggestedSeverity: finding.severity,
                },
            };
        }
        const context = {
            recentDismissals: [...this.dismissals],
            serviceHistory: this.buildServiceHistory(finding.serviceId),
        };
        const assessment = await this.llmEvaluator(finding, context);
        const confidence = assessment.confidence;
        const suppressThreshold = this.dismissThreshold / 2;
        let action;
        if (confidence < suppressThreshold) {
            action = 'suppress';
        }
        else if (confidence < this.dismissThreshold) {
            action = 'downgrade';
        }
        else {
            action = 'keep';
        }
        return { action, assessment };
    }
    /** Record that a user dismissed a finding. */
    recordDismissal(findingType, serviceId) {
        this.dismissals.push({
            findingType,
            serviceId,
            dismissedAt: new Date().toISOString(),
        });
    }
    /** Return overall noise statistics. */
    getNoiseRate() {
        const total = this.totalEvaluated;
        const dismissed = this.dismissals.length;
        const rate = total === 0 ? 0 : dismissed / total;
        return { total, dismissed, rate };
    }
    // Private
    buildServiceHistory(serviceId) {
        const serviceDismissals = this.dismissals.filter((d) => d.serviceId === serviceId);
        return {
            totalFindings: this.totalEvaluated,
            dismissedCount: serviceDismissals.length,
        };
    }
}
//# sourceMappingURL=noise-reducer.js.map
