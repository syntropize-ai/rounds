/**
 * SLO Burn Monitor - monitors SLO burn rates and generates findings
 * when error budget is being consumed at an unsustainable rate.
 *
 * Uses multi-window burn rate approach (Google SRE style):
 * - 5m window burn_rate > 14.4 = critical (1h budget consumed in 5m)
 * - 1h window burn_rate > 6    = high
 * - 6h window burn_rate > 1    = medium (steady budget consumption)
 */
export interface SloDefinition {
    serviceId: string;
    metricName: string;
    /** The SLO target (e.g. 0.999 for 99.9% availability) */
    target: number;
    /** Window for the SLO (e.g. '30d') */
    window: string;
}

export interface BurnRateReading {
    serviceId: string;
    metricName: string;
    /** Measured error rate in the evaluation window */
    errorRate: number;
    /** Timestamp of the reading */
    timestamp: string;
    /** Evaluation window (e.g. '5m', '1h', '6h') */
    evaluationWindow: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface BurnRateFinding {
    id: string;
    serviceId: string;
    metricName: string;
    severity: FindingSeverity;
    burnRate: number;
    errorBudgetRemainingPercent: number;
    evaluationWindow: string;
    message: string;
    timestamp: string;
}

export interface BurnRateDataProvider {
    /**
     * Get the current error rate for a service/metric in the given window.
     * Returns undefined if data is unavailable.
     */
    getErrorRate(serviceId: string, metricName: string, window: string): Promise<number | undefined>;
}

export interface SloBurnMonitorConfig {
    /** How often to check burn rates in ms (default: 60_000) */
    checkIntervalMs?: number;
    /** Burn rate thresholds per window */
    thresholds?: BurnRateThreshold[];
}

export interface BurnRateThreshold {
    window: string;
    burnRateThreshold: number;
    severity: FindingSeverity;
}

export declare class SloBurnMonitor {
    private readonly slos;
    private readonly provider;
    private readonly thresholds;
    private readonly checkIntervalMs;
    private timer;
    private readonly listeners;
    private findingCounter;
    constructor(slos: SloDefinition[], provider: BurnRateDataProvider, config?: SloBurnMonitorConfig);
    /** Register a listener for burn rate findings */
    onFinding(listener: (finding: BurnRateFinding) => void): void;
    /** Start periodic monitoring */
    start(): void;
    /** Stop periodic monitoring */
    stop(): void;
    /** Run a single check cycle across all SLOs and windows */
    check(): Promise<BurnRateFinding[]>;
    /**
     * Calculate burn rate from raw error rate and SLO target.
     * Exported for use by other components.
     */
    static calculateBurnRate(errorRate: number, sloTarget: number): number;
    /**
     * Determine severity from burn rate using default thresholds.
     */
    static severityFromBurnRate(burnRate: number): FindingSeverity;
    private estimateWindowFactor;
}
//# sourceMappingURL=slo-burn-monitor.d.ts.map
