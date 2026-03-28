// LogAdapter - implements DataAdapter for log backends (Loki / Elasticsearch / ClickHouse)
import { LokiHttpClient, MockLogClient } from './client.js';
import { clusterLogs } from './clusterer.js';
import { LOG_SUPPORTED_METRICS } from './types.js';

export class LogAdapter {
    name;
    description = 'Log adapter - supports Loki, Elasticsearch, and ClickHouse backends';
    client;
    defaultLimit;
    clusterSamples;

    constructor(options) {
        this.name = options.name ?? 'log';
        this.defaultLimit = options.defaultLimit ?? 1000;
        this.clusterSamples = options.clusterSamples ?? 3;
        if (options.client) {
            this.client = options.client;
        }
        else {
            switch (options.config.backend) {
                case 'loki':
                    this.client = new LokiHttpClient(options.config);
                    break;
                case 'mock':
                    this.client = new MockLogClient();
                    break;
                default:
                    throw new Error(`Log backend "${options.config.backend}" is not yet implemented`);
            }
        }
    }

    // — DataAdapter ———————————————————————————————————————————————————————————
    meta() {
        return {
            supportedMetrics: [...LOG_SUPPORTED_METRICS],
            timeGranularity: '1s',
            dimensions: [
                { name: 'namespace', description: 'Kubernetes namespace' },
                { name: 'pod', description: 'Pod name' },
                { name: 'level', description: 'Log level filter (e.g. error, warn)' },
                { name: 'pattern', description: 'Free-text regex pattern filter' },
            ],
            supportedSignalTypes: ['logs'],
            supportsStreaming: false,
            supportsHistoricalQuery: true,
            maxLookbackSeconds: 30 * 24 * 3600, // 30 days
        };
    }

    async query(semanticQuery) {
        const startMs = Date.now();
        const { entity, metric, timeRange, filters, limit } = semanticQuery;
        const lines = await this.client.queryLogs({
            entity,
            start: timeRange.start,
            end: timeRange.end,
            filters: filters,
            limit: limit ?? this.defaultLimit,
        });
        let data;
        let queryUsed;
        switch (metric) {
            case 'log_clusters': {
                const clusters = clusterLogs(lines, this.clusterSamples);
                data = { lines, clusters, totalCount: lines.length };
                queryUsed = `log_clusters entity=${entity} clusters=${clusters.length}`;
                break;
            }
            case 'log_rate': {
                // Return rate as a single-element array with count per second
                const windowSec = Math.max(1, (timeRange.end.getTime() - timeRange.start.getTime()) / 1000);
                const rate = lines.length / windowSec;
                data = { lines: [], totalCount: lines.length };
                queryUsed = `log_rate entity=${entity} rate=${rate.toFixed(3)}/s`;
                break;
            }
            case 'error_log_rate': {
                const errorLines = lines.filter((l) => l.level === 'error' || l.level === 'fatal');
                const windowSec = Math.max(1, (timeRange.end.getTime() - timeRange.start.getTime()) / 1000);
                const rate = errorLines.length / windowSec;
                data = { lines: errorLines, totalCount: errorLines.length };
                queryUsed = `error_log_rate entity=${entity} rate=${rate.toFixed(3)}/s`;
                break;
            }
            case 'log_volume': {
                // Approximate: sum of message byte lengths
                const bytes = lines.reduce((acc, l) => acc + Buffer.byteLength(l.message, 'utf8'), 0);
                data = { lines: [], totalCount: lines.length };
                queryUsed = `log_volume entity=${entity} bytes=${bytes}`;
                break;
            }
            default: {
                // 'log_lines' or unknown - return raw lines
                data = { lines, totalCount: lines.length };
                queryUsed = `log_lines entity=${entity} count=${lines.length}`;
                break;
            }
        }
        return {
            data: data,
            metadata: {
                adapterName: this.name,
                signalType: 'logs',
                executedAt: new Date().toISOString(),
                coveredRange: timeRange,
                partial: false,
            },
            queryUsed,
            cost: {
                durationMs: Date.now() - startMs,
                pointsScanned: lines.length,
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
        }
        catch (err) {
            return {
                status: 'unavailable',
                message: err instanceof Error ? err.message : String(err),
                latencyMs: Date.now() - start,
                checkedAt: new Date().toISOString(),
            };
        }
    }
}
//# sourceMappingURL=adapter.js.map