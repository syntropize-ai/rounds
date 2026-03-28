import { translateToPromQL, getSupportedMetrics } from './translator.js';

export class PrometheusAdapter {
    name = "prometheus";
    description = 'Prometheus metrics adapter';

    constructor(config, fetchFn = fetch) {
        this.config = {
            timeoutMs: 30_000,
            headers: {},
            auth: undefined,
            ...config,
        };
        this.fetchFn = fetchFn;
    }

    meta() {
        return {
            supportedMetrics: getSupportedMetrics(),
            timeGranularity: '15s',
            dimensions: [
                { name: 'service', description: 'Service name label' },
                { name: 'namespace', description: 'Kubernetes namespace' },
                { name: 'status', description: 'HTTP status code' },
                { name: 'method', description: 'HTTP method' },
            ],
            supportedSignalTypes: ['metrics'],
            supportsStreaming: false,
            supportsHistoricalQuery: true,
            maxLookbackSeconds: 90 * 24 * 3600, // 90 days
        };
    }

    async query(semanticQuery) {
        const startMs = Date.now();
        const promql = await translateToPromQL(semanticQuery);
        const durationSecs = Math.round((semanticQuery.timeRange.end.getTime() - semanticQuery.timeRange.start.getTime()) / 1000);
        // Use range query for time window, instant query otherwise
        let data;
        let warnings;
        if (semanticQuery.limit) {
            const step = this.inferStep(durationSecs, semanticQuery.limit);
            const result = await this.rangeQuery(promql, semanticQuery.timeRange.start, semanticQuery.timeRange.end, step);
            data = this.matrixToTimeSeries(result.data.result);
            warnings = result.warnings;
        } else {
            const result = await this.instantQuery(promql, semanticQuery.timeRange.end);
            data = this.vectorToTimeSeries(result.data.result);
        }

        const durationMs = Date.now() - startMs;
        return {
            data,
            metadata: {
                adapterName: this.name,
                signalType: 'metrics',
                executedAt: new Date().toISOString(),
                coveredRange: semanticQuery.timeRange,
                partial: false,
                warnings: warnings && warnings.length > 0 ? warnings : undefined,
            },
            queryUsed: promql,
            cost: {
                durationMs,
            },
        };
    }

    stream(_semanticQuery) {
        throw new Error('PrometheusAdapter does not support streaming');
    }

    async healthCheck() {
        const start = Date.now();
        try {
            const url = `${this.config.baseUrl}/-/ready`;
            const resp = await this.doFetch(url);
            const latencyMs = Date.now() - start;
            if (resp.ok) {
                return {
                    status: 'healthy',
                    latencyMs,
                    checkedAt: new Date().toISOString(),
                };
            }
            return {
                status: 'degraded',
                latencyMs,
                message: `Prometheus returned ${resp.status}`,
                checkedAt: new Date().toISOString(),
            };
        } catch (err) {
            return {
                status: 'unavailable',
                message: err instanceof Error ? err.message : String(err),
                checkedAt: new Date().toISOString(),
            };
        }
    }

    async instantQuery(promql, time) {
        const params = new URLSearchParams({
            query: promql,
        });
        if (time) {
            params.set('time', String(time.getTime() / 1000));
        }
        const url = `${this.config.baseUrl}/api/v1/query?${params.toString()}`;
        const resp = await this.doFetch(url);
        const body = await resp.json();
        if (body.status !== 'success') {
            throw new Error(`Prometheus query failed: ${body.error ?? 'unknown error'}`);
        }
        return body;
    }

    async rangeQuery(promql, start, end, step) {
        const params = new URLSearchParams({
            query: promql,
            start: String(start.getTime() / 1000),
            end: String(end.getTime() / 1000),
            step,
        });
        const url = `${this.config.baseUrl}/api/v1/query_range?${params.toString()}`;
        const resp = await this.doFetch(url);
        const body = await resp.json();
        if (body.status !== 'success') {
            throw new Error(`Prometheus range query failed: ${body.error ?? 'unknown error'}`);
        }
        return body;
    }

    async doFetch(url) {
        const headers = { ...this.config.headers };
        if (this.config.auth) {
            const encoded = Buffer.from(`${this.config.auth.username}:${this.config.auth.password}`).toString('base64');
            headers['Authorization'] = `Basic ${encoded}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            return await this.fetchFn(url, { headers, signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }
    }

    vectorToTimeSeries(items) {
        return items.map((item) => ({
            labels: item.metric,
            points: [
                {
                    timestamp: item.value[0] * 1000,
                    value: parseFloat(item.value[1]),
                },
            ],
        }));
    }

    matrixToTimeSeries(items) {
        return items.map((item) => ({
            labels: item.metric,
            points: item.values.map(([ts, val]) => ({
                timestamp: ts * 1000,
                value: parseFloat(val),
            })),
        }));
    }

    /** Choose a step interval for range queries to cap result size around 300 points */
    inferStep(durationSecs, limit) {
        const maxPoints = limit ?? 300;
        const stepSecs = Math.max(15, Math.ceil(durationSecs / maxPoints));
        if (stepSecs >= 3600) {
            return `${stepSecs / 3600}h`;
        }
        if (stepSecs >= 60) {
            return `${stepSecs / 60}m`;
        }
        return `${stepSecs}s`;
    }
}

//# sourceMappingURL=adapter.js.map