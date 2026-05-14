// Concrete Prometheus implementation of the canonical IMetricsAdapter.

import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import { checkEndpointHealth } from '../shared/health-check.js';
import { AdapterError, classifyHttpError } from '../errors.js';
import type {
  IMetricsAdapter,
  MetricSample,
  MetricMetadata,
  RangeResult,
} from '../interfaces.js';

const log = createLogger('metrics-adapter');

const ADAPTER_ID = 'prometheus';

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

function transportError(op: string, err: unknown): AdapterError {
  const kind = classifyHttpError({ cause: err });
  return new AdapterError(
    kind,
    `Prometheus ${op} transport failure: ${err instanceof Error ? err.message : String(err)}`,
    { adapterId: ADAPTER_ID, operation: op, originalError: err },
  );
}

function httpError(op: string, status: number): AdapterError {
  const kind = classifyHttpError({ status });
  return new AdapterError(
    kind,
    `Prometheus ${op} HTTP ${status}`,
    { adapterId: ADAPTER_ID, operation: op, status },
  );
}

async function parseJson<T>(res: Response, op: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new AdapterError(
      'malformed_response',
      `Prometheus ${op}: malformed response body`,
      { adapterId: ADAPTER_ID, operation: op, originalError: err },
    );
  }
}

export class PrometheusMetricsAdapter implements IMetricsAdapter {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string> = {},
    private timeoutMs = 15_000,
  ) {}

  async listMetricNames(): Promise<string[]> {
    const op = 'listMetricNames';
    const url = `${this.base}/api/v1/label/__name__/values`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      log.warn({ err, url, op }, 'prometheus listMetricNames transport failure');
      throw transportError(op, err);
    }
    if (!res.ok) {
      log.warn({ url, status: res.status, op }, 'prometheus returned non-ok');
      throw httpError(op, res.status);
    }
    const body = await parseJson<PrometheusApiResponse<string[]>>(res, op);
    return Array.isArray(body.data) ? body.data : [];
  }

  async listLabels(metric: string): Promise<string[]> {
    const op = 'listLabels';
    const params = new URLSearchParams();
    params.set('match[]', metric);
    const url = `${this.base}/api/v1/labels?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      log.warn({ err, url, metric, op }, 'prometheus listLabels transport failure');
      throw transportError(op, err);
    }
    if (!res.ok) {
      log.warn({ url, status: res.status, metric, op }, 'prometheus returned non-ok');
      throw httpError(op, res.status);
    }
    const body = await parseJson<PrometheusApiResponse<string[]>>(res, op);
    const labels = Array.isArray(body.data) ? body.data : [];
    return labels.filter((l) => l !== '__name__');
  }

  async listLabelValues(label: string): Promise<string[]> {
    const op = 'listLabelValues';
    const url = `${this.base}/api/v1/label/${encodeURIComponent(label)}/values`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      log.warn({ err, url, label, op }, 'prometheus listLabelValues transport failure');
      throw transportError(op, err);
    }
    if (!res.ok) {
      log.warn({ url, status: res.status, label, op }, 'prometheus returned non-ok');
      throw httpError(op, res.status);
    }
    const body = await parseJson<PrometheusApiResponse<string[]>>(res, op);
    return Array.isArray(body.data) ? body.data : [];
  }

  async findSeries(matchers: string[]): Promise<string[]> {
    if (matchers.length === 0) return [];
    const op = 'findSeries';
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
      log.warn({ err, url, matchers, op }, 'prometheus findSeries transport failure');
      throw transportError(op, err);
    }
    if (!res.ok) {
      log.warn({ url, status: res.status, matchers, op }, 'prometheus returned non-ok');
      throw httpError(op, res.status);
    }
    const body = await parseJson<PrometheusApiResponse<Array<Record<string, string>>>>(res, op);
    const names = new Set<string>();
    for (const series of body.data ?? []) {
      if (series['__name__']) names.add(series['__name__']);
    }
    return [...names].sort();
  }

  async instantQuery(expr: string, time?: Date): Promise<MetricSample[]> {
    const op = 'instantQuery';
    const params = new URLSearchParams();
    params.set('query', expr);
    params.set('time', String(Math.floor((time ?? new Date()).getTime() / 1000)));
    const url = `${this.base}/api/v1/query?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw transportError(op, err);
    }
    if (!res.ok) {
      throw httpError(op, res.status);
    }
    const body = await parseJson<PrometheusApiResponse<{
      resultType: string;
      result: PrometheusVectorResult[];
    }>>(res, op);
    if (body.status !== 'success') {
      throw new AdapterError(
        'bad_request',
        `Prometheus ${op} returned status=${body.status}: ${body.error ?? 'no error field'}`,
        { adapterId: ADAPTER_ID, operation: op, providerCode: body.error },
      );
    }
    return (body.data?.result ?? []).map((r) => ({
      labels: r.metric,
      value: Number(r.value[1]),
      timestamp: r.value[0],
    }));
  }

  async rangeQuery(expr: string, start: Date, end: Date, step: string): Promise<RangeResult[]> {
    const op = 'rangeQuery';
    const params = new URLSearchParams();
    params.set('query', expr);
    params.set('start', String(Math.floor(start.getTime() / 1000)));
    params.set('end', String(Math.floor(end.getTime() / 1000)));
    params.set('step', step);
    const url = `${this.base}/api/v1/query_range?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw transportError(op, err);
    }
    if (!res.ok) {
      throw httpError(op, res.status);
    }
    const body = await parseJson<PrometheusApiResponse<{
      resultType: string;
      result: PrometheusMatrixResult[];
    }>>(res, op);
    if (body.status !== 'success') {
      throw new AdapterError(
        'bad_request',
        `Prometheus ${op} returned status=${body.status}: ${body.error ?? 'no error field'}`,
        { adapterId: ADAPTER_ID, operation: op, providerCode: body.error },
      );
    }
    return (body.data?.result ?? []).map((r) => ({
      metric: r.metric,
      values: r.values,
    }));
  }

  async fetchMetadata(metricNames?: string[]): Promise<Record<string, MetricMetadata>> {
    const op = 'fetchMetadata';
    const params = new URLSearchParams();
    if (metricNames) {
      for (const name of metricNames) params.append('metric', name);
    }
    const url = `${this.base}/api/v1/metadata?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      log.warn({ err, url, op }, 'prometheus fetchMetadata transport failure');
      throw transportError(op, err);
    }
    if (!res.ok) {
      log.warn({ url, status: res.status, op }, 'prometheus returned non-ok');
      throw httpError(op, res.status);
    }
    let body: PrometheusApiResponse<Record<string, PrometheusMetadataEntry[]>>;
    try {
      body = (await res.json()) as PrometheusApiResponse<Record<string, PrometheusMetadataEntry[]>>;
    } catch (err) {
      log.warn({ err, url, op }, 'prometheus fetchMetadata: malformed JSON body');
      throw new AdapterError(
        'malformed_response',
        `Prometheus ${op}: malformed response body`,
        { adapterId: ADAPTER_ID, operation: op, originalError: err },
      );
    }
    if (body.status !== 'success' || !body.data) {
      // status=error with a populated error field is the documented Prometheus
      // failure shape; treat it the same as a malformed body.
      throw new AdapterError(
        'malformed_response',
        `Prometheus ${op} returned status=${body.status}: ${body.error ?? 'no error field'}`,
        { adapterId: ADAPTER_ID, operation: op, providerCode: body.error },
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
