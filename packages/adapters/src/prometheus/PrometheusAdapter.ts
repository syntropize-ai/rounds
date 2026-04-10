// PrometheusAdapter - implements DataAdapter for Prometheus

import type { DataAdapter } from '../adapter.js';
import type {
  SemanticQuery,
  StructuredResult,
  Capabilities,
  AdapterHealth,
} from '../types.js';
import type { PrometheusAdapterConfig, TimeSeries } from './types.js';
import type { IPrometheusClient } from './client.js';
import { PrometheusHttpClient } from './client.js';
import { translateToPromQL, getSupportedMetrics } from './translator.js';

export interface PrometheusAdapterOptions {
  config: PrometheusAdapterConfig;
  /** Inject a custom client (useful for testing with MockPrometheusClient) */
  client?: IPrometheusClient;
  /** Adapter instance name, defaults to "prometheus" */
  name?: string;
}

export class PrometheusAdapter implements DataAdapter {
  readonly name: string;
  readonly description = 'Prometheus metrics adapter - supports range and instant queries';

  private readonly client: IPrometheusClient;

  constructor(options: PrometheusAdapterOptions) {
    this.name = options.name ?? 'prometheus';
    this.client = options.client ?? new PrometheusHttpClient(options.config);
  }

  meta(): Capabilities {
    return {
      supportedMetrics: getSupportedMetrics(),
      timeGranularity: '1s',
      dimensions: [
        { name: 'service', description: 'Kubernetes service name' },
        { name: 'namespace', description: 'Kubernetes namespace' },
        { name: 'pod', description: 'Pod name' },
        { name: 'status', description: 'HTTP response status code' },
        { name: 'method', description: 'HTTP method' },
      ],
      supportedSignalTypes: ['metrics'],
      supportsStreaming: false,
      supportsHistoricalQuery: true,
      maxLookbackSeconds: 30 * 24 * 3600, // 30 days
    };
  }

  async query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>> {
    const startMs = Date.now();

    const { promql, window } = translateToPromQL(semanticQuery);

    const isInstant = this.isInstantQuery(semanticQuery);
    let series: TimeSeries[];
    let warnings: string[] | undefined;

    if (isInstant) {
      const res = await this.client.instantQuery(promql, semanticQuery.timeRange.end);
      if (res.status === 'error') {
        throw new Error(`Prometheus error (${res.errorType}): ${res.error}`);
      }
      warnings = res.warnings;
      series = res.data.result.map((item) => ({
        labels: item.metric,
        points: [
          {
            timestamp: item.value[0] * 1000,
            value: parseFloat(item.value[1]),
          },
        ],
      }));
    } else {
      const step = this.resolveStep(semanticQuery);
      const res = await this.client.rangeQuery(
        promql,
        semanticQuery.timeRange.start,
        semanticQuery.timeRange.end,
        step,
      );
      if (res.status === 'error') {
        throw new Error(`Prometheus error (${res.errorType}): ${res.error}`);
      }
      warnings = res.warnings;
      series = res.data.result.map((item) => ({
        labels: item.metric,
        points: item.values.map(([ts, val]) => ({
          timestamp: ts * 1000,
          value: parseFloat(val),
        })),
      }));
    }

    const durationMs = Date.now() - startMs;

    return {
      data: series as T,
      queryUsed: promql,
      metadata: {
        adapterName: this.name,
        signalType: 'metrics',
        executedAt: new Date().toISOString(),
        coveredRange: semanticQuery.timeRange,
        partial: false,
        warnings,
      },
      cost: {
        durationMs,
        pointsScanned: series.reduce((acc, s) => acc + s.points.length, 0),
      },
    };
  }

  async healthCheck(): Promise<AdapterHealth> {
    const start = Date.now();
    try {
      const alive = await this.client.health();
      return {
        status: alive ? 'healthy' : 'unavailable',
        latencyMs: Date.now() - start,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // -- Helpers --

  private isInstantQuery(query: SemanticQuery): boolean {
    const rangeMs =
      query.timeRange.end.getTime() - query.timeRange.start.getTime();
    // Treat as instant if range < 1 minute
    return rangeMs < 60_000;
  }

  private resolveStep(query: SemanticQuery): string {
    if (query.aggregation?.interval) return query.aggregation.interval;
    const rangeMs = query.timeRange.end.getTime() - query.timeRange.start.getTime();
    const rangeSeconds = rangeMs / 1000;
    // Aim for ~300 data points
    const stepSeconds = Math.max(15, Math.round(rangeSeconds / 300));
    if (stepSeconds % 3600 === 0) return `${stepSeconds / 3600}h`;
    if (stepSeconds % 60 === 0) return `${stepSeconds / 60}m`;
    return `${stepSeconds}s`;
  }
}