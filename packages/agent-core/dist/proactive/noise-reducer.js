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
    recordDismissal(findingType, serviceId) {
        this.dismissals.push({
            findingType,
            serviceId,
            dismissedAt: new Date().toISOString(),
        });
    }
    getNoiseRate() {
        const total = this.totalEvaluated;
        const dismissed = this.dismissals.length;
        const rate = total === 0 ? 0 : dismissed / total;
        return { total, dismissed, rate };
    }
    buildServiceHistory(serviceId) {
        const serviceDismissals = this.dismissals.filter((d) => d.serviceId === serviceId);
        return {
            totalFindings: this.totalEvaluated,
            dismissedCount: serviceDismissals.length,
        };
    }
}
//# sourceMappingURL=noise-reducer.js.map