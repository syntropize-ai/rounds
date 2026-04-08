// Types are structurally compatible with IMetricsAdapter from @agentic-obs/agent-core.
// We avoid importing from agent-core directly to prevent a circular package dependency.

interface MetricSample {
  labels: Record<string, string>;
  value: number;
  timestamp: number;
}

interface MetricMetadata {
  type: string;
  help: string;
  unit: string;
}

interface RangeResult {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

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

export class PrometheusMetricsAdapter {
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
    const res = await this.fetch(url);
    if (!res.ok) return [];
    const body = (await res.json()) as PrometheusApiResponse<string[]>;
    const labels = Array.isArray(body.data) ? body.data : [];
    return labels.filter((l) => l !== '__name__');
  }

  async listLabelValues(label: string): Promise<string[]> {
    const url = `${this.base}/api/v1/label/${encodeURIComponent(label)}/values`;
    const res = await this.fetch(url);
    if (!res.ok) return [];
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
    const res = await this.fetch(url);
    if (!res.ok) return [];
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
    try {
      const res = await this.fetch(url);
      if (!res.ok) return {};
      const body = (await res.json()) as PrometheusApiResponse<Record<string, PrometheusMetadataEntry[]>>;
      if (body.status !== 'success' || !body.data) return {};

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
    } catch {
      return {};
    }
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.base}/-/healthy`, 5_000);
      return res.ok;
    } catch {
      return false;
    }
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
