import { PrometheusHttpClient } from './client.js';
import { translateToPromQL, getSupportedMetrics } from './translator.js';

export class PrometheusAdapter {
    constructor(options) {
        this.name = options.name ?? 'prometheus';
        this.client = options.client ?? new PrometheusHttpClient(options.config);
    }

    meta() {
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

    async query(semanticQuery) {
        const startMs = Date.now();
        const { promql, window } = translateToPromQL(semanticQuery);
        const isInstant = this.isInstantQuery(semanticQuery);
        let series;
        let warnings;

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
            const res = await this.client.rangeQuery(promql, semanticQuery.timeRange.start, semanticQuery.timeRange.end, step);
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
            data: series,
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

    async healthCheck() {
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

    // Helpers
    isInstantQuery(query) {
        const rangeMs = query.timeRange.end.getTime() - query.timeRange.start.getTime();
        // Treat as instant if range < 1 minute
        return rangeMs < 60_000;
    }

    resolveStep(query) {
        if (query.aggregation?.interval) {
            return query.aggregation.interval;
        }
        const rangeMs = query.timeRange.end.getTime() - query.timeRange.start.getTime();
        const rangeSeconds = rangeMs / 1000;
        // Aim for ~300 data points
        const stepSeconds = Math.max(15, Math.round(rangeSeconds / 300));
        if (stepSeconds % 3600 === 0) return `${stepSeconds / 3600}h`;
        if (stepSeconds % 60 === 0) return `${stepSeconds / 60}m`;
        return `${stepSeconds}s`;
    }
}