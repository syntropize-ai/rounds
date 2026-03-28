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
    /** The current observed value */
    value: number;
    /** The threshold value that was exceeded */
    threshold: number;
    message: string;
    timestamp: string;
}

export interface MetricDataProvider {
    /**
     * Fetch the latest value for a service metric.
     * Returns undefined when data is unavailable.
     */
    getCurrentValue(serviceId: string, metricName: string): Promise<number | undefined>;
}

export interface AnomalyDetectorConfig {
    /** How often to poll metrics in ms (default: 60_000) */
    checkIntervalMs?: number;
    /** Number of historical samples to retain per metric (default: 60) */
    historySize?: number;
    /** Min samples required before running anomaly checks (default: 10) */
    minSamples?: number;
    /** z-score threshold for anomaly detection (default: 3.0) */
    zscoreThreshold?: number;
    /** Percentile threshold, 0..1 (default: 0.99) */
    percentileThreshold?: number;
    /** Period-over-period change threshold as a ratio (default: 0.5 = 50%) */
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
    /** Register a callback invoked whenever an anomaly finding is generated. */
    onFinding(listener: (finding: AnomalyFinding) => void): void;
    /** Start periodic detection. Runs an immediate check then polls on interval. */
    start(): void;
    /** Stop periodic detection. */
    stop(): void;
    /** Run one detection cycle across all registered metrics. */
    check(): Promise<AnomalyFinding[]>;
    /** Evaluate all algorithms for one metric observation. */
    evaluate(descriptor: MetricDescriptor, value: number, history: number[], previousValue?: number | undefined): AnomalyFinding[];
    /** Return the current history snapshot for a metric (useful in tests). */
    getHistory(serviceId: string, metricName: string): number[];
    /** Return how many metrics are being monitored. */
    getMetricCount(): number;
}
//# sourceMappingURL=anomaly-detector.d.ts.map
