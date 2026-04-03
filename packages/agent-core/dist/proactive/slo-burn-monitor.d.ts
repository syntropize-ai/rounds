/**
 * SLO Burn Monitor - monitors SLO burn rates and generates findings
 * when error budget is being consumed at an unsustainable rate.
 *
 * Uses multi-window burn rate approach (Google SRE style):
 * - 5m window burn_rate > 14.4 = critical (1h budget consumed in 5m)
 * - 1h window burn_rate > 6    = high
 * - 6h window burn_rate > 1    = medium (steady budget consumption)
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export interface SloTarget {
    serviceId: string;
    metricName: string;
    target: number;
}
export interface BurnRateThreshold {
    window: string;
    burnRateThreshold: number;
    severity: FindingSeverity;
}
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
export interface BurnRateProvider {
    getErrorRate(serviceId: string, metricName: string, window: string): Promise<number | undefined>;
}
export interface SloBurnMonitorConfig {
    thresholds?: BurnRateThreshold[];
    checkIntervalMs?: number;
}
export declare class SloBurnMonitor {
    private readonly slos;
    private readonly provider;
    private readonly thresholds;
    private readonly checkIntervalMs;
    private timer;
    private readonly listeners;
    private findingCounter;
    constructor(slos: SloTarget[], provider: BurnRateProvider, config?: SloBurnMonitorConfig);
    onFinding(listener: (finding: BurnRateFinding) => void): void;
    start(): void;
    stop(): void;
    check(): Promise<BurnRateFinding[]>;
    static calculateBurnRate(errorRate: number, sloTarget: number): number;
    static severityFromBurnRate(burnRate: number): FindingSeverity;
    private estimateWindowFactor;
}
//# sourceMappingURL=slo-burn-monitor.d.ts.map