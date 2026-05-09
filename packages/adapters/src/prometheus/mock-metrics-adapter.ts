// MockMetricsAdapter — deterministic in-memory IMetricsAdapter for the
// `openobs demo` zero-credential demo path. Never wired into normal mode;
// the api-gateway only constructs it when OPENOBS_DEMO=1 is set.
//
// The fixture covers the canonical "API latency spike" investigation:
//   - api_request_rate_total       (5 series, one per route)
//   - api_request_latency_seconds  (5 series, p99 baked into values)
//   - cpu_usage_percent            (3 series, one spiked to 92% so the
//                                   demo CPU-usage alert rule fires)
//   - memory_usage_bytes           (3 series)
//   - error_rate_total             (2 series)
//
// `instantQuery` does not parse PromQL — it pattern-matches on metric
// name prefixes and returns the seeded samples. That is enough for the
// demo investigation script and the alert evaluator's threshold check.

import type {
  IMetricsAdapter,
  MetricSample,
  MetricMetadata,
  RangeResult,
} from '../interfaces.js';

interface MockSeries {
  metric: string;
  labels: Record<string, string>;
  /** Steady-state value used by instantQuery + range fill. */
  value: number;
}

const FIXTURE: MockSeries[] = [
  // -- request rate (req/s)
  { metric: 'api_request_rate_total', labels: { route: '/users', method: 'GET' }, value: 42.5 },
  { metric: 'api_request_rate_total', labels: { route: '/orders', method: 'POST' }, value: 18.2 },
  { metric: 'api_request_rate_total', labels: { route: '/checkout', method: 'POST' }, value: 7.4 },
  { metric: 'api_request_rate_total', labels: { route: '/health', method: 'GET' }, value: 60.0 },
  { metric: 'api_request_rate_total', labels: { route: '/search', method: 'GET' }, value: 12.1 },

  // -- request latency (seconds, p99-ish — /checkout is the spike)
  { metric: 'api_request_latency_seconds', labels: { route: '/users', quantile: '0.99' }, value: 0.12 },
  { metric: 'api_request_latency_seconds', labels: { route: '/orders', quantile: '0.99' }, value: 0.18 },
  { metric: 'api_request_latency_seconds', labels: { route: '/checkout', quantile: '0.99' }, value: 2.45 },
  { metric: 'api_request_latency_seconds', labels: { route: '/health', quantile: '0.99' }, value: 0.01 },
  { metric: 'api_request_latency_seconds', labels: { route: '/search', quantile: '0.99' }, value: 0.34 },

  // -- cpu usage (percent) — api-server pod is hot
  { metric: 'cpu_usage_percent', labels: { pod: 'api-server-0', namespace: 'demo' }, value: 92.0 },
  { metric: 'cpu_usage_percent', labels: { pod: 'worker-0', namespace: 'demo' }, value: 34.0 },
  { metric: 'cpu_usage_percent', labels: { pod: 'cache-0', namespace: 'demo' }, value: 12.0 },

  // -- memory usage (bytes)
  { metric: 'memory_usage_bytes', labels: { pod: 'api-server-0', namespace: 'demo' }, value: 524_288_000 },
  { metric: 'memory_usage_bytes', labels: { pod: 'worker-0', namespace: 'demo' }, value: 209_715_200 },
  { metric: 'memory_usage_bytes', labels: { pod: 'cache-0', namespace: 'demo' }, value: 1_073_741_824 },

  // -- error rate (5xx/s)
  { metric: 'error_rate_total', labels: { route: '/checkout', status: '500' }, value: 0.8 },
  { metric: 'error_rate_total', labels: { route: '/orders', status: '500' }, value: 0.05 },
];

function uniqueMetricNames(): string[] {
  return [...new Set(FIXTURE.map((s) => s.metric))];
}

function matchesMetric(expr: string, metricName: string): boolean {
  // Cheap prefix match — full PromQL parsing is out of scope for the demo.
  // `cpu_usage_percent > 80` and `cpu_usage_percent` both match.
  return expr.startsWith(metricName);
}

export class MockMetricsAdapter implements IMetricsAdapter {
  async listMetricNames(): Promise<string[]> {
    return uniqueMetricNames();
  }

  async listLabels(metric: string): Promise<string[]> {
    const labels = new Set<string>();
    for (const s of FIXTURE) {
      if (s.metric === metric) {
        for (const k of Object.keys(s.labels)) labels.add(k);
      }
    }
    return [...labels];
  }

  async listLabelValues(label: string): Promise<string[]> {
    const values = new Set<string>();
    for (const s of FIXTURE) {
      const v = s.labels[label];
      if (v) values.add(v);
    }
    return [...values];
  }

  async findSeries(matchers: string[]): Promise<string[]> {
    // matchers like ['cpu_usage_percent'] — we just return matching metric names.
    return FIXTURE
      .filter((s) => matchers.some((m) => matchesMetric(m, s.metric)))
      .map((s) => s.metric);
  }

  async fetchMetadata(metricNames?: string[]): Promise<Record<string, MetricMetadata>> {
    const all: Record<string, MetricMetadata> = {
      api_request_rate_total: { type: 'counter', help: 'Requests per second', unit: 'req/s' },
      api_request_latency_seconds: { type: 'gauge', help: 'Request latency p99', unit: 'seconds' },
      cpu_usage_percent: { type: 'gauge', help: 'CPU utilization', unit: 'percent' },
      memory_usage_bytes: { type: 'gauge', help: 'Memory usage', unit: 'bytes' },
      error_rate_total: { type: 'counter', help: 'HTTP 5xx error rate', unit: 'err/s' },
    };
    if (!metricNames) return all;
    const filtered: Record<string, MetricMetadata> = {};
    for (const n of metricNames) if (all[n]) filtered[n] = all[n];
    return filtered;
  }

  async instantQuery(expr: string, time?: Date): Promise<MetricSample[]> {
    const ts = Math.floor((time ?? new Date()).getTime() / 1000);
    return FIXTURE
      .filter((s) => matchesMetric(expr, s.metric))
      .map((s) => ({ labels: { __name__: s.metric, ...s.labels }, value: s.value, timestamp: ts }));
  }

  async rangeQuery(expr: string, start: Date, end: Date, step: string): Promise<RangeResult[]> {
    const startSec = Math.floor(start.getTime() / 1000);
    const endSec = Math.floor(end.getTime() / 1000);
    const stepSec = Math.max(1, parseStepSeconds(step));
    const matched = FIXTURE.filter((s) => matchesMetric(expr, s.metric));
    return matched.map((s) => {
      const values: Array<[number, string]> = [];
      for (let t = startSec; t <= endSec; t += stepSec) {
        values.push([t, s.value.toString()]);
      }
      return { metric: { __name__: s.metric, ...s.labels }, values };
    });
  }

  async testQuery(expr: string): Promise<{ ok: boolean; error?: string }> {
    const matches = FIXTURE.some((s) => matchesMetric(expr, s.metric));
    return matches ? { ok: true } : { ok: false, error: `no fixture series for '${expr}'` };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}

function parseStepSeconds(step: string): number {
  // Accept "15s", "1m", "30" (bare seconds).
  const m = step.match(/^(\d+)(s|m|h)?$/);
  if (!m) return 15;
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 'm': return n * 60;
    case 'h': return n * 3600;
    default: return n;
  }
}
