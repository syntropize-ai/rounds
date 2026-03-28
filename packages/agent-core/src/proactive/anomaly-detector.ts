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

const DEFAULTS: Required<AnomalyDetectorConfig> = {
  checkIntervalMs: 60_000,
  historySize: 60,
  minSamples: 10,
  zscoreThreshold: 3.0,
  percentileThreshold: 0.99,
  popThreshold: 0.5,
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx] ?? 0;
}

function severityFromZscore(z: number): AnomalySeverity {
  const abs = Math.abs(z);
  if (abs > 6) return 'critical';
  if (abs > 4) return 'high';
  if (abs > 3) return 'medium';
  return 'low';
}

function severityFromPopChange(ratio: number, threshold: number): AnomalySeverity {
  const factor = Math.abs(ratio) / threshold;
  if (factor >= 4) return 'critical';
  if (factor >= 2) return 'high';
  if (factor >= 1.5) return 'medium';
  return 'low';
}

class RingBuffer {
  private readonly buf: number[] = [];
  private readonly max: number;

  constructor(maxSize: number) {
    this.max = maxSize;
  }

  push(value: number): void {
    this.buf.push(value);
    if (this.buf.length > this.max) {
      this.buf.shift();
    }
  }

  get values(): number[] {
    return [...this.buf];
  }

  get previous(): number | undefined {
    return this.buf.length >= 2 ? this.buf[this.buf.length - 2] : undefined;
  }
}

export class AnomalyDetector {
  private readonly metrics: MetricDescriptor[];
  private readonly provider: MetricDataProvider;
  private readonly cfg: Required<AnomalyDetectorConfig>;
  private readonly history = new Map<string, RingBuffer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners: Array<(finding: AnomalyFinding) => void> = [];
  private findingCounter = 0;

  constructor(
    metrics: MetricDescriptor[],
    provider: MetricDataProvider,
    config: AnomalyDetectorConfig = {},
  ) {
    this.metrics = metrics;
    this.provider = provider;
    this.cfg = { ...DEFAULTS, ...config };
  }

  onFinding(listener: (finding: AnomalyFinding) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.cfg.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<AnomalyFinding[]> {
    const findings: AnomalyFinding[] = [];

    for (const descriptor of this.metrics) {
      const value = await this.provider.getCurrentValue(descriptor.serviceId, descriptor.metricName);
      if (value === undefined) continue;

      const key = `${descriptor.serviceId}:${descriptor.metricName}`;
      let buf = this.history.get(key);
      if (!buf) {
        buf = new RingBuffer(this.cfg.historySize);
        this.history.set(key, buf);
      }

      const historicalValues = buf.values;
      if (historicalValues.length >= this.cfg.minSamples) {
        const newFindings = this.evaluate(descriptor, value, historicalValues, buf.previous);
        for (const f of newFindings) {
          findings.push(f);
          for (const listener of this.listeners) {
            listener(f);
          }
        }
      }

      buf.push(value);
    }

    return findings;
  }

  evaluate(
    descriptor: MetricDescriptor,
    value: number,
    history: number[],
    previousValue?: number,
  ): AnomalyFinding[] {
    const findings: AnomalyFinding[] = [];
    const direction = descriptor.direction ?? 'both';

    const avg = mean(history);
    const sd = stddev(history, avg);
    if (sd > 0) {
      const z = (value - avg) / sd;
      const absZ = Math.abs(z);
      const exceedsThreshold =
        absZ >= this.cfg.zscoreThreshold &&
        (direction === 'both' ||
          (direction === 'up' && z > 0) ||
          (direction === 'down' && z < 0));

      if (exceedsThreshold) {
        findings.push({
          id: `anomaly-${++this.findingCounter}`,
          serviceId: descriptor.serviceId,
          metricName: descriptor.metricName,
          anomalyType: 'zscore',
          severity: severityFromZscore(z),
          value,
          threshold: avg + this.cfg.zscoreThreshold * sd * (z > 0 ? 1 : -1),
          message: `${descriptor.serviceId}/${descriptor.metricName} z-score ${z.toFixed(2)} (value=${value.toFixed(4)}, mean=${avg.toFixed(4)}, stddev=${sd.toFixed(4)})`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const sorted = [...history].sort((a, b) => a - b);
    const p99 = percentile(sorted, this.cfg.percentileThreshold);
    if (p99 > 0 && (direction === 'both' || direction === 'up') && value > p99) {
      findings.push({
        id: `anomaly-${++this.findingCounter}`,
        serviceId: descriptor.serviceId,
        metricName: descriptor.metricName,
        anomalyType: 'percentile',
        severity: value > p99 * 1.5 ? 'high' : 'medium',
        value,
        threshold: p99,
        message: `${descriptor.serviceId}/${descriptor.metricName} exceeds p${Math.round(this.cfg.percentileThreshold * 100)} (${value.toFixed(4)} vs p99=${p99.toFixed(4)})`,
        timestamp: new Date().toISOString(),
      });
    }

    if (previousValue !== undefined && previousValue !== 0) {
      const changeRatio = (value - previousValue) / Math.abs(previousValue);
      const absChange = Math.abs(changeRatio);
      const exceedsPop =
        absChange >= this.cfg.popThreshold &&
        (direction === 'both' ||
          (direction === 'up' && changeRatio > 0) ||
          (direction === 'down' && changeRatio < 0));

      if (exceedsPop) {
        findings.push({
          id: `anomaly-${++this.findingCounter}`,
          serviceId: descriptor.serviceId,
          metricName: descriptor.metricName,
          anomalyType: 'period_over_period',
          severity: severityFromPopChange(changeRatio, this.cfg.popThreshold),
          value,
          threshold: previousValue * (1 + this.cfg.popThreshold * Math.sign(changeRatio)),
          message: `${descriptor.serviceId}/${descriptor.metricName} changed ${(changeRatio * 100).toFixed(1)}% vs previous value ${previousValue.toFixed(4)} (threshold=${(this.cfg.popThreshold * 100).toFixed(0)}%)`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return findings;
  }

  getHistory(serviceId: string, metricName: string): number[] {
    return this.history.get(`${serviceId}:${metricName}`)?.values ?? [];
  }

  getMetricCount(): number {
    return this.metrics.length;
  }
}
