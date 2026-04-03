import type { AnomalyFinding, AnomalySeverity } from './anomaly-detector.js';
export interface NoiseAssessment {
    confidence: number;
    reasoning: string;
    suggestedSeverity: AnomalySeverity;
}
export interface NoiseEvaluationResult {
    action: 'keep' | 'downgrade' | 'suppress';
    assessment: NoiseAssessment;
}
export interface DismissalRecord {
    findingType: string;
    serviceId: string;
    dismissedAt: string;
}
export interface NoiseReducerConfig {
    llmEvaluator?: (finding: AnomalyFinding, context: {
        recentDismissals: DismissalRecord[];
        serviceHistory: {
            totalFindings: number;
            dismissedCount: number;
        };
    }) => Promise<NoiseAssessment>;
    dismissThreshold?: number;
}
export declare class NoiseReducer {
    private readonly llmEvaluator?;
    private readonly dismissThreshold;
    private readonly dismissals;
    private totalEvaluated;
    constructor(config?: NoiseReducerConfig);
    evaluate(finding: AnomalyFinding): Promise<NoiseEvaluationResult>;
    recordDismissal(findingType: string, serviceId: string): void;
    getNoiseRate(): {
        total: number;
        dismissed: number;
        rate: number;
    };
    private buildServiceHistory;
}
//# sourceMappingURL=noise-reducer.d.ts.map