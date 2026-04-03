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
  getErrorRate(
    serviceId: string,
    metricName: string,
    window: string,
  ): Promise<number | undefined>;
}

export interface SloBurnMonitorConfig {
  thresholds?: BurnRateThreshold[];
  checkIntervalMs?: number;
}

const DEFAULT_THRESHOLDS: BurnRateThreshold[] = [
  { window: '5m', burnRateThreshold: 14.4, severity: 'critical' },
  { window: '1h', burnRateThreshold: 6, severity: 'high' },
  { window: '6h', burnRateThreshold: 1, severity: 'medium' },
];

export class SloBurnMonitor {
  private readonly slos: SloTarget[];
  private readonly provider: BurnRateProvider;
  private readonly thresholds: BurnRateThreshold[];
  private readonly checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners: Array<(finding: BurnRateFinding) => void> = [];
  private findingCounter = 0;

  constructor(
    slos: SloTarget[],
    provider: BurnRateProvider,
    config: SloBurnMonitorConfig = {},
  ) {
    this.slos = slos;
    this.provider = provider;
    this.thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;
  }

  onFinding(listener: (finding: BurnRateFinding) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<BurnRateFinding[]> {
    const findings: BurnRateFinding[] = [];

    for (const slo of this.slos) {
      const errorBudget = 1 - slo.target;

      for (const threshold of this.thresholds) {
        const errorRate = await this.provider.getErrorRate(
          slo.serviceId,
          slo.metricName,
          threshold.window,
        );
        if (errorRate === undefined) {
          continue;
        }

        const burnRate = errorBudget > 0 ? errorRate / errorBudget : 0;
        if (burnRate >= threshold.burnRateThreshold) {
          const budgetRemaining = Math.max(
            0,
            1 - (burnRate / this.estimateWindowFactor(threshold.window)) * 100,
          );
          const finding: BurnRateFinding = {
            id: `burn-${++this.findingCounter}`,
            serviceId: slo.serviceId,
            metricName: slo.metricName,
            severity: threshold.severity,
            burnRate,
            errorBudgetRemainingPercent: budgetRemaining,
            evaluationWindow: threshold.window,
            message: `${slo.serviceId} ${slo.metricName} burn rate ${burnRate.toFixed(1)}x in ${threshold.window} window (threshold: ${threshold.burnRateThreshold}). Error budget at risk.`,
            timestamp: new Date().toISOString(),
          };

          findings.push(finding);

          for (const listener of this.listeners) {
            listener(finding);
          }

          break;
        }
      }
    }

    return findings;
  }

  static calculateBurnRate(errorRate: number, sloTarget: number): number {
    const errorBudget = 1 - sloTarget;
    return errorBudget > 0 ? errorRate / errorBudget : 0;
  }

  static severityFromBurnRate(burnRate: number): FindingSeverity {
    if (burnRate >= 14.4) return 'critical';
    if (burnRate >= 6) return 'high';
    if (burnRate >= 1) return 'medium';
    if (burnRate >= 0.5) return 'low';
    return 'info';
  }

  private estimateWindowFactor(window: string): number {
    const windowMinutes = parseWindowMinutes(window);
    const sloPeriodMinutes = 30 * 24 * 60;
    return sloPeriodMinutes / windowMinutes;
  }
}

function parseWindowMinutes(window: string): number {
  const match = window.match(/^(\d+)([mhd])$/);
  if (!match) return 60;

  const [, numStr, unit] = match;
  const num = parseInt(numStr!, 10);
  switch (unit) {
    case 'm':
      return num;
    case 'h':
      return num * 60;
    case 'd':
      return num * 24 * 60;
    default:
      return 60;
  }
}
