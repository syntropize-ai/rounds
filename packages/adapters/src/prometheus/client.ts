// Prometheus HTTP API client (real + mock)

import { createLogger } from '@agentic-obs/common/logging';
import { checkEndpointHealth } from '../shared/health-check.js';
import { AdapterError, classifyHttpError } from '../errors.js';

const log = createLogger('prometheus-client');
const ADAPTER_ID = 'prometheus';

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
    return checkEndpointHealth(`${this.baseUrl}/-/healthy`, {
      logger: log,
      timeoutMs: this.timeoutMs,
    });
  }

  private async fetch(path: string): Promise<unknown> {
    const op = 'fetch';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AdapterError(
        classifyHttpError({ cause: err }),
        `Prometheus client fetch transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { adapterId: ADAPTER_ID, operation: op, originalError: err },
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AdapterError(
        classifyHttpError({ status: res.status }),
        `Prometheus HTTP error ${res.status}`,
        {
          adapterId: ADAPTER_ID,
          operation: op,
          status: res.status,
          upstreamBody: body.slice(0, 1000),
        },
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new AdapterError(
        'malformed_response',
        'Prometheus client fetch: malformed JSON body',
        { adapterId: ADAPTER_ID, operation: op, originalError: err },
      );
    }
  }
}

