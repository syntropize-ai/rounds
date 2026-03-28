// SemanticQuery -> PromQL translator

/** Map semantic metric names to PromQL template functions */
const METRIC_TEMPLATES = {
    request_rate: (entity, window, filters) => {
        const labelStr = buildLabelSelector({ service: entity, ...filters });
        return `sum(rate(http_requests_total{${labelStr}}[${window}]))`;
    },
    error_rate: (entity, window, filters) => {
        const labelStr = buildLabelSelector({ service: entity, ...filters });
        const errLabelStr = buildLabelSelector({ service: entity, status: "~\"5..\"", ...filters });
        return `(sum(rate(http_requests_total{${errLabelStr}}[${window}])) / 
                sum(rate(http_requests_total{${labelStr}}[${window}])))`;
    },
    p50_latency: (entity, window, filters) => buildHistogramQuantile(0.5, entity, window, filters),
    p95_latency: (entity, window, filters) => buildHistogramQuantile(0.95, entity, window, filters),
    p99_latency: (entity, window, filters) => buildHistogramQuantile(0.99, entity, window, filters),
    saturation: (entity, window, filters) => {
        const labelStr = buildLabelSelector({ namespace: entity, ...filters });
        const safeEntity = escapePromQLRegex(entity);
        return `(avg(rate(container_cpu_usage_seconds_total{${labelStr},pod=~"${safeEntity}-.*"}[${window}])) / 
                avg(kube_pod_container_resource_limits{${labelStr},pod=~"${safeEntity}-.*",resource="cpu"}))`;
    },
    availability: (entity, window, filters) => {
        const labelStr = buildLabelSelector({ service: entity, ...filters });
        const errLabelStr = buildLabelSelector({ service: entity, status: "~\"5..\"", ...filters });
        return `(1 - (sum(rate(http_requests_total{${errLabelStr}}[${window}])) / 
                sum(rate(http_requests_total{${labelStr}}[${window}]))))`;
    },
};

/** Escape a PromQL label value to prevent injection. */
function escapePromQLLabelValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape a string for safe use inside a PromQL regex matcher. */
function escapePromQLRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLabelSelector(labels) {
    return Object.entries(labels)
        .filter(([_, v]) => v !== undefined && v !== '')
        .map(([k, v]) => {
            // Support "~..." regex matchers passed as values
            if (v.startsWith('~')) {
                return `${k}=~${v.slice(1)}`;
            }
            return `${k}="${escapePromQLLabelValue(v)}"`;
        })
        .join(',');
}

function buildHistogramQuantile(quantile, entity, window, filters) {
    const labelStr = buildLabelSelector({ service: entity, ...filters });
    return `histogram_quantile(${quantile}, 
            sum(rate(http_request_duration_seconds_bucket{${labelStr}}[${window}])) by (le)) * 1000`;
}

/** Convert a duration in seconds to a Prometheus-compatible window string */
function secondsToWindow(seconds) {
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
}

function buildAggregationWrapper(innerExpr, fn) {
    if (!fn || fn === 'avg') return innerExpr;
    const fnMap = {
        avg: 'avg', sum: 'sum', min: 'min', max: 'max', count: 'count',
        rate: 'rate',
        p50: 'quantile(0.50, ',
        p90: 'quantile(0.90, ',
        p95: 'quantile(0.95, ',
        p99: 'quantile(0.99, ',
    };
    const mapped = fnMap[fn];
    if (!mapped) return innerExpr;
    if (fn.startsWith('p')) {
        return `${mapped}${innerExpr})`;
    }
    return `${mapped}(${innerExpr})`;
}

export function translateToPromQL(query) {
    const templateFn = METRIC_TEMPLATES[query.metric];
    if (!templateFn) {
        throw new Error(`Unsupported metric "${query.metric}". Supported: ${Object.keys(METRIC_TEMPLATES).join(', ')}`);
    }

    const rangeSeconds = Math.round((query.timeRange.end.getTime() - query.timeRange.start.getTime()) / 1000);
    const window = query.aggregation?.interval
        || secondsToWindow(Math.min(rangeSeconds, 300)); // default 5m for instant queries

    const extraFilters = {};
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

export function getSupportedMetrics() {
    return Object.keys(METRIC_TEMPLATES);
}