// Concrete Prometheus implementation of the canonical IMetricsAdapter.

import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import { checkEndpointHealth } from '../shared/health-check.js';
import { AdapterError, classifyAdapterHttpError } from '../adapter.js';
import type {
  IMetricsAdapter,
  MetricSample,
  MetricMetadata,
  RangeResult,
} from '../interfaces.js';

const log = createLogger('metrics-adapter');

const ADAPTER_NAME = 'prometheus';

interface PrometheusMetadataEntry {
  type: string;
  help: string;
  unit: string;
}

interface PrometheusApiResponse<T> {
  status: string;
  data: T;
  error?: string;
}

interface PrometheusVectorResult {
  metric: Record<string, string>;
  value: [number, string];
}

interface PrometheusMatrixResult {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export class PrometheusMetricsAdapter implements IMetricsAdapter {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string> = {},
    private timeoutMs = 15_000,
  ) {}

  async listMetricNames(): Promise<string[]> {
    const url = `${this.base}/api/v1/label/__name__/values`;
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new Error(`Prometheus returned HTTP ${res.status} fetching metric names`);
    }
    const body = (await res.json()) as PrometheusApiResponse<string[]>;
    return Array.isArray(body.data) ? body.data : [];
  }

  async listLabels(metric: string): Promise<string[]> {
    const params = new URLSearchParams();
    params.set('match[]', metric);
    const url = `${this.base}/api/v1/labels?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      const kind = classifyAdapterHttpError({ cause: err });
      log.warn({ err, url, metric, op: 'listLabels', kind }, 'prometheus listLabels transport failure');
      throw new AdapterError(
        `Prometheus listLabels failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind, adapter: ADAPTER_NAME, cause: err },
      );
    }
    if (!res.ok) {
      const kind = classifyAdapterHttpError({ status: res.status });
      log.warn({ url, status: res.status, metric, op: 'listLabels', kind }, 'prometheus returned non-ok');
      throw new AdapterError(
        `Prometheus listLabels HTTP ${res.status}`,
        { kind, adapter: ADAPTER_NAME, status: res.status },
      );
    }
    const body = (await res.json()) as PrometheusApiResponse<string[]>;
    const labels = Array.isArray(body.data) ? body.data : [];
    return labels.filter((l) => l !== '__name__');
  }

  async listLabelValues(label: string): Promise<string[]> {
    const url = `${this.base}/api/v1/label/${encodeURIComponent(label)}/values`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      const kind = classifyAdapterHttpError({ cause: err });
      log.warn({ err, url, label, op: 'listLabelValues', kind }, 'prometheus listLabelValues transport failure');
      throw new AdapterError(
        `Prometheus listLabelValues failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind, adapter: ADAPTER_NAME, cause: err },
      );
    }
    if (!res.ok) {
      const kind = classifyAdapterHttpError({ status: res.status });
      log.warn({ url, status: res.status, label, op: 'listLabelValues', kind }, 'prometheus returned non-ok');
      throw new AdapterError(
        `Prometheus listLabelValues HTTP ${res.status}`,
        { kind, adapter: ADAPTER_NAME, status: res.status },
      );
    }
    const body = (await res.json()) as PrometheusApiResponse<string[]>;
    return Array.isArray(body.data) ? body.data : [];
  }

  async findSeries(matchers: string[]): Promise<string[]> {
    if (matchers.length === 0) return [];
    const params = new URLSearchParams();
    for (const m of matchers) params.append('match[]', m);
    const now = Math.floor(Date.now() / 1000);
    params.set('start', String(now - 300));
    params.set('end', String(now));

    const url = `${this.base}/api/v1/series?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      const kind = classifyAdapterHttpError({ cause: err });
      log.warn({ err, url, matchers, op: 'findSeries', kind }, 'prometheus findSeries transport failure');
      throw new AdapterError(
        `Prometheus findSeries failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind, adapter: ADAPTER_NAME, cause: err },
      );
    }
    if (!res.ok) {
      const kind = classifyAdapterHttpError({ status: res.status });
      log.warn({ url, status: res.status, matchers, op: 'findSeries', kind }, 'prometheus returned non-ok');
      throw new AdapterError(
        `Prometheus findSeries HTTP ${res.status}`,
        { kind, adapter: ADAPTER_NAME, status: res.status },
      );
    }
    const body = (await res.json()) as PrometheusApiResponse<Array<Record<string, string>>>;
    const names = new Set<string>();
    for (const series of body.data ?? []) {
      if (series['__name__']) names.add(series['__name__']);
    }
    return [...names].sort();
  }

  async instantQuery(expr: string, time?: Date): Promise<MetricSample[]> {
    const params = new URLSearchParams();
    params.set('query', expr);
    params.set('time', String(Math.floor((time ?? new Date()).getTime() / 1000)));
    const url = `${this.base}/api/v1/query?${params}`;
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new Error(`Prometheus returned HTTP ${res.status} for instant query`);
    }
    const body = (await res.json()) as PrometheusApiResponse<{
      resultType: string;
      result: PrometheusVectorResult[];
    }>;
    if (body.status !== 'success') {
      throw new Error(body.error ?? 'Query failed');
    }
    return (body.data?.result ?? []).map((r) => ({
      labels: r.metric,
      value: Number(r.value[1]),
      timestamp: r.value[0],
    }));
  }

  async rangeQuery(expr: string, start: Date, end: Date, step: string): Promise<RangeResult[]> {
    const params = new URLSearchParams();
    params.set('query', expr);
    params.set('start', String(Math.floor(start.getTime() / 1000)));
    params.set('end', String(Math.floor(end.getTime() / 1000)));
    params.set('step', step);
    const url = `${this.base}/api/v1/query_range?${params}`;
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new Error(`Prometheus returned HTTP ${res.status} for range query`);
    }
    const body = (await res.json()) as PrometheusApiResponse<{
      resultType: string;
      result: PrometheusMatrixResult[];
    }>;
    if (body.status !== 'success') {
      throw new Error(body.error ?? 'Range query failed');
    }
    return (body.data?.result ?? []).map((r) => ({
      metric: r.metric,
      values: r.values,
    }));
  }

  async fetchMetadata(metricNames?: string[]): Promise<Record<string, MetricMetadata>> {
    const params = new URLSearchParams();
    if (metricNames) {
      for (const name of metricNames) params.append('metric', name);
    }
    const url = `${this.base}/api/v1/metadata?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      const kind = classifyAdapterHttpError({ cause: err });
      log.warn({ err, url, op: 'fetchMetadata', kind }, 'prometheus fetchMetadata transport failure');
      throw new AdapterError(
        `Prometheus fetchMetadata failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind, adapter: ADAPTER_NAME, cause: err },
      );
    }
    if (!res.ok) {
      const kind = classifyAdapterHttpError({ status: res.status });
      log.warn({ url, status: res.status, op: 'fetchMetadata', kind }, 'prometheus returned non-ok');
      throw new AdapterError(
        `Prometheus fetchMetadata HTTP ${res.status}`,
        { kind, adapter: ADAPTER_NAME, status: res.status },
      );
    }
    let body: PrometheusApiResponse<Record<string, PrometheusMetadataEntry[]>>;
    try {
      body = (await res.json()) as PrometheusApiResponse<Record<string, PrometheusMetadataEntry[]>>;
    } catch (err) {
      log.warn({ err, url, op: 'fetchMetadata' }, 'prometheus fetchMetadata: malformed JSON body');
      throw new AdapterError(
        `Prometheus fetchMetadata: malformed response body`,
        { kind: 'malformed', adapter: ADAPTER_NAME, cause: err },
      );
    }
    if (body.status !== 'success' || !body.data) {
      // status=error with a populated error field is the documented Prometheus
      // failure shape; treat it the same as a malformed body.
      throw new AdapterError(
        `Prometheus fetchMetadata returned status=${body.status}: ${body.error ?? 'no error field'}`,
        { kind: 'malformed', adapter: ADAPTER_NAME },
      );
    }

    const result: Record<string, MetricMetadata> = {};
    for (const [name, entries] of Object.entries(body.data)) {
      const entry = entries[0];
      if (entry) {
        result[name] = {
          type: entry.type ?? '',
          help: entry.help ?? '',
          unit: entry.unit ?? '',
        };
      }
    }
    return result;
  }

  async testQuery(expr: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const params = new URLSearchParams();
      params.set('query', expr);
      const url = `${this.base}/api/v1/query?${params}`;
      const res = await this.fetch(url, 5_000);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const body = (await res.json()) as { status?: string; error?: string };
      if (body.status !== 'success') {
        return { ok: false, error: body.error ?? 'Query returned non-success status' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: getErrorMessage(err) };
    }
  }

  async isHealthy(): Promise<boolean> {
    return checkEndpointHealth(`${this.base}/-/healthy`, {
      logger: log,
      timeoutMs: 5_000,
    });
  }

  private get base(): string {
    return this.baseUrl.replace(/\/$/, '');
  }

  private fetch(url: string, timeoutMs?: number): Promise<Response> {
    return fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
  }
}
