// SemanticQuery → PromQL translator

import type { SemanticQuery, AggregationFunction } from '../types.js';

/** Map semantic metric names to PromQL template functions */
const METRIC_TEMPLATES: Record
  string,
  (entity: string, window: string, filters: Record<string, string>) => string
> = {
  request_rate: (entity, window, filters) => {
    const labelStr = buildLabelSelector({ service: entity, ...filters });
    return `sum(rate(http_requests_total{${labelStr}}[${window}]))`;
  },

  error_rate: (entity, window, filters) => {
    const labelStr = buildLabelSelector({ service: entity, ...filters });
    const errLabelStr = buildLabelSelector({ service: entity, status: '~"5.."', ...filters });
    return (
      `sum(rate(http_requests_total{${errLabelStr}}[${window}])) / ` +
      `sum(rate(http_requests_total{${labelStr}}[${window}]))`
    );
  },

  p50_latency: (entity, window, filters) =>
    buildHistogramQuantile(0.5, entity, window, filters),

  p95_latency: (entity, window, filters) =>
    buildHistogramQuantile(0.95, entity, window, filters),

  p99_latency: (entity, window, filters) =>
    buildHistogramQuantile(0.99, entity, window, filters),

  saturation: (entity, window, filters) => {
    const labelStr = buildLabelSelector({ namespace: entity, ...filters });
    const safeEntity = escapePromQLRegex(entity);
    return (
      `avg(rate(container_cpu_usage_seconds_total{${labelStr},pod=~"${safeEntity}-.*"}[${window}])) / ` +
      `avg(kube_pod_container_resource_limits{${labelStr},pod=~"${safeEntity}-.*",resource="cpu"})`
    );
  },

  availability: (entity, window, filters) => {
    const labelStr = buildLabelSelector({ service: entity, ...filters });
    const errLabelStr = buildLabelSelector({ service: entity, status: '~"5.."', ...filters });
    return (
      `1 - (sum(rate(http_requests_total{${errLabelStr}}[${window}])) / ` +
      `sum(rate(http_requests_total{${labelStr}}[${window}])))`
    );
  },
};

/**
 * Escape a PromQL label value to prevent injection.
 * Backslashes must be escaped first, then double quotes.
 */
function escapePromQLLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape a string for safe use inside a PromQL regex matcher (~=).
 * Escapes regex metacharacters so user-provided values match literally.
 */
function escapePromQLRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLabelSelector(labels: Record<string, string>): string {
  return Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => {
      // Support ~"..." regex matchers passed as values (internal use only, not from user input)
      if (v.startsWith('~')) return `${k}=${v}`;
      return `${k}="${escapePromQLLabelValue(v)}"`;
    })
    .join(',');
}

function buildHistogramQuantile(
  quantile: number,
  entity: string,
  window: string,
  filters: Record<string, string>,
): string {
  const labelStr = buildLabelSelector({ service: entity, ...filters });
  return (
    `histogram_quantile(${quantile}, ` +
    `sum(rate(http_request_duration_seconds_bucket{${labelStr}}[${window}])) by (le)) * 1000`
  );
}

/** Convert a duration in seconds to a Prometheus-compatible window string */
function secondsToWindow(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function buildAggregationWrapper(innerExpr: string, fn?: AggregationFunction): string {
  if (!fn || fn === 'avg') return innerExpr;
  const fnMap: Record<AggregationFunction, string> = {
    avg: 'avg',
    sum: 'sum',
    min: 'min',
    max: 'max',
    count: 'count',
    rate: 'rate',
    p50: 'quantile(0.50, ',
    p90: 'quantile(0.90, ',
    p95: 'quantile(0.95, ',
    p99: 'quantile(0.99, ',
  };
  const mapped = fnMap[fn];
  if (!mapped) return innerExpr;
  if (fn.startsWith('p')) return `${mapped}${innerExpr})`;
  return `${mapped}(${innerExpr})`;
}

export interface TranslatedQuery {
  promql: string;
  window: string;
}

/**
 * Translate a SemanticQuery into a PromQL expression.
 * Throws if the metric name is not supported.
 */
export function translateToPromQL(query: SemanticQuery): TranslatedQuery {
  const templateFn = METRIC_TEMPLATES[query.metric];
  if (!templateFn) {
    throw new Error(
      `Unsupported metric "${query.metric}". Supported: ${Object.keys(METRIC_TEMPLATES).join(', ')}`,
    );
  }

  const rangeSeconds = Math.round(
    (query.timeRange.end.getTime() - query.timeRange.start.getTime()) / 1000,
  );
  const window =
    query.aggregation?.interval
      ? query.aggregation.interval
      : secondsToWindow(Math.min(rangeSeconds, 300)); // default 5m for instant queries

  const extraFilters: Record<string, string> = {};
  if (query.filters) {
    for (const [k, v] of Object.entries(query.filters)) {
      extraFilters[k] = Array.isArray(v)
        ? `~"${v.map(escapePromQLRegex).join('|')}"`
        : v;
    }
  }

  let promql = templateFn(query.entity, window, extraFilters);

  if (query.aggregation?.function) {
    promql = buildAggregationWrapper(promql, query.aggregation.function);
  }

  return { promql, window };
}

export function getSupportedMetrics(): string[] {
  return Object.keys(METRIC_TEMPLATES);
}