export interface ProactiveFinding {
    type: 'anomaly' | 'slo_burn' | 'change';
    serviceId: string;
    message: string;
    severity: string;
    timestamp: string;
}

export interface DismissalRecord {
    findingType: string;
    serviceId: string;
    dismissedAt: string;
}

export interface NoiseContext {
    recentDismissals: DismissalRecord[];
    serviceHistory: {
        totalFindings: number;
        dismissedCount: number;
    };
}

export interface NoiseAssessment {
    /** 0-1 confidence that this finding is genuine signal (not noise) */
    confidence: number;
    reasoning: string;
    suggestedSeverity: string;
}

export interface NoiseReducerConfig {
    /**
     * LLM-backed evaluator. When provided, every finding is assessed by the LLM.
     * When omitted, all findings are kept without filtering.
     */
    llmEvaluator?: (finding: ProactiveFinding, context: NoiseContext) => Promise<NoiseAssessment>;
    /**
     * Confidence value below which a finding is considered noise.
     * Findings with confidence in [dismissThreshold/2, dismissThreshold] are downgraded;
     * findings below dismissThreshold/2 are suppressed.
     * Default: 0.3
     */
    dismissThreshold?: number;
}

export declare class NoiseReducer {
    private readonly llmEvaluator?;
    private readonly dismissThreshold;
    private readonly dismissals;
    private totalEvaluated;
    constructor(config?: NoiseReducerConfig);
    /**
     * Evaluate a finding and decide whether to keep, downgrade, or suppress it.
     *
     * Without an LLM evaluator, all findings are kept (no hardcoded filtering).
     * With an LLM evaluator:
     * - confidence >= dismissThreshold                 -> keep
     * - confidence in [dismissThreshold/2, dismissThreshold) -> downgrade
     * - confidence < dismissThreshold/2                -> suppress
     */
    evaluate(finding: ProactiveFinding): Promise<{
        action: 'keep' | 'downgrade' | 'suppress';
        assessment: NoiseAssessment;
    }>;
    /** Record that a user dismissed a finding. */
    recordDismissal(findingType: string, serviceId: string): void;
    /** Return overall noise statistics. */
    getNoiseRate(): {
        total: number;
        dismissed: number;
        rate: number;
    };
    private buildServiceHistory;
}
//# sourceMappingURL=noise-reducer.d.ts.map
