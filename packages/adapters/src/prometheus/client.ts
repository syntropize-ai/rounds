// Prometheus HTTP API client (real + mock)

import { createLogger } from '@agentic-obs/common';

const log = createLogger('prometheus-client');

import type {
  PrometheusAdapterConfig,
  PrometheusQueryResponse,
  PrometheusRangeResponse,
} from './types.js';

export interface IPrometheusClient {
  instantQuery(promql: string, time?: Date): Promise<PrometheusQueryResponse>;
  rangeQuery(promql: string, start: Date, end: Date, step: string): Promise<PrometheusRangeResponse>;
  health(): Promise<boolean>;
}

// -- Real HTTP client --

export class PrometheusHttpClient implements IPrometheusClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: PrometheusAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.headers = { 'Content-Type': 'application/json', ...(config.headers ?? {}) };
    if (config.auth) {
      const token = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
      this.headers['Authorization'] = `Basic ${token}`;
    }
  }

  async instantQuery(promql: string, time?: Date): Promise<PrometheusQueryResponse> {
    const params = new URLSearchParams({ query: promql });
    if (time) params.set('time', String(time.getTime() / 1000));

    const res = await this.fetch(`/api/v1/query?${params}`);
    return res as PrometheusQueryResponse;
  }

  async rangeQuery(
    promql: string,
    start: Date,
    end: Date,
    step: string,
  ): Promise<PrometheusRangeResponse> {
    const params = new URLSearchParams({
      query: promql,
      start: String(start.getTime() / 1000),
      end: String(end.getTime() / 1000),
      step,
    });
    const res = await this.fetch(`/api/v1/query_range?${params}`);
    return res as PrometheusRangeResponse;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/-/healthy`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok;
    } catch (err) {
      log.debug({ err }, 'failed to check Prometheus health');
      return false;
    }
  }

  private async fetch(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Prometheus HTTP error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }
}

// -- Mock client for testing --

export interface MockSeries {
  metric: Record<string, string>;
  /** For range queries: array of [timestamp_seconds, value_string] */
  values?: [number, string][];
  /** For instant queries: [timestamp_seconds, value_string] */
  value?: [number, string];
}

export class MockPrometheusClient implements IPrometheusClient {
  private series: MockSeries[] = [];
  private healthy = true;

  setSeries(series: MockSeries[]): void {
    this.series = series;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  async health(): Promise<boolean> {
    return this.healthy;
  }

  async instantQuery(promql: string, time?: Date): Promise<PrometheusQueryResponse> {
    const ts = time ? time.getTime() / 1000 : Date.now() / 1000;
    return {
      status: 'success',
      data: {
        resultType: 'vector',
        result: this.series.map((s) => ({
          metric: s.metric,
          value: s.value ?? [ts, '0'],
        })),
      },
    };
  }

  async rangeQuery(
    promql: string,
    start: Date,
    end: Date,
    step: string,
  ): Promise<PrometheusRangeResponse> {
    return {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: this.series.map((s) => ({
          metric: s.metric,
          values: s.values ?? this.generateSyntheticValues(start, end, step),
        })),
      },
    };
  }

  private generateSyntheticValues(start: Date, end: Date, step: string): [number, string][] {
    const stepSeconds = parseStep(step);
    const points: [number, string][] = [];
    let t = Math.floor(start.getTime() / 1000);
    const endTs = Math.floor(end.getTime() / 1000);
    while (t <= endTs) {
      // Synthetic sine wave + small noise for realistic-looking data
      const value = (Math.sin(t / 60) * 0.1 + 0.5).toFixed(4);
      points.push([t, value]);
      t += stepSeconds;
    }
    return points;
  }
}

function parseStep(step: string): number {
  const match = step.match(/^(\d+)([smhd]?)$/);
  if (!match) return 60;
  const n = parseInt(match[1] ?? '60', 10);
  switch (match[2]) {
    case 'h': return n * 3600;
    case 'm': return n * 60;
    case 'd': return n * 86400;
    default: return n;
  }
}