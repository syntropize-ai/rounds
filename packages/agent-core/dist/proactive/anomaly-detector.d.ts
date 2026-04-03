/**
 * Anomaly Detector - statistical semantic-metric anomaly detection engine.
 *
 * Supported algorithms:
 * - zscore:           Current value deviates > N stddevs from rolling mean
 * - percentile:       Current value exceeds rolling p99
 * - period_over_period: Current value changed > X% vs previous window
 */
export type AnomalyType = 'zscore' | 'percentile' | 'period_over_period';
export type AnomalySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export interface MetricDescriptor {
    serviceId: string;
    metricName: string;
    /** Direction that constitutes an anomaly: 'up' | 'down' | 'both' (default: 'both') */
    direction?: 'up' | 'down' | 'both';
}
export interface AnomalyFinding {
    id: string;
    serviceId: string;
    metricName: string;
    anomalyType: AnomalyType;
    severity: AnomalySeverity;
    value: number;
    threshold: number;
    message: string;
    timestamp: string;
}
export interface MetricDataProvider {
    getCurrentValue(serviceId: string, metricName: string): Promise<number | undefined>;
}
export interface AnomalyDetectorConfig {
    checkIntervalMs?: number;
    historySize?: number;
    minSamples?: number;
    zscoreThreshold?: number;
    percentileThreshold?: number;
    popThreshold?: number;
}
export declare class AnomalyDetector {
    private readonly metrics;
    private readonly provider;
    private readonly cfg;
    private readonly history;
    private timer;
    private readonly listeners;
    private findingCounter;
    constructor(metrics: MetricDescriptor[], provider: MetricDataProvider, config?: AnomalyDetectorConfig);
    onFinding(listener: (finding: AnomalyFinding) => void): void;
    start(): void;
    stop(): void;
    check(): Promise<AnomalyFinding[]>;
    evaluate(descriptor: MetricDescriptor, value: number, history: number[], previousValue?: number): AnomalyFinding[];
    getHistory(serviceId: string, metricName: string): number[];
    getMetricCount(): number;
}
//# sourceMappingURL=anomaly-detector.d.ts.map