export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown';

export interface LogLine {
    /** ISO-8601 timestamp */
    timestamp: string;
    level: LogLevel;
    message: string;
    service: string;
    /** All labels/fields attached to this log entry */
    labels: Record<string, string>;
    traceId?: string;
    spanId?: string;
}

export interface LogCluster {
    /** Stable cluster identifier (hash of template) */
    id: string;
    /** Extracted message template with variable parts replaced by <*> */
    template: string;
    count: number;
    /** Up to 3 representative raw log lines */
    sampleLines: LogLine[];
    /** Dominant log level in this cluster */
    level: LogLevel;
    firstSeen: string;
    lastSeen: string;
}

export interface LogQueryResult {
    lines: LogLine[];
    /** Present when clustering was requested (metric='log_clusters') */
    clusters?: LogCluster[];
    totalCount: number;
}

export type LogBackend = 'loki' | 'elasticsearch' | 'clickhouse' | 'mock';

export interface LogAdapterConfig {
    backend: LogBackend;
    /** Base URL of the log backend, e.g. http://loki:3100 */
    baseUrl: string;
    /** Optional basic auth */
    auth?: {
        username: string;
        password: string;
    };
    /** Request timeout in milliseconds (default: 30_000) */
    timeoutMs?: number;
    /** Extra HTTP headers forwarded to the backend */
    headers?: Record<string, string>;
}

export interface LokiStreamValue {
    /** [unixNanosTimestamp, logLine] */
    values: [string, string][];
    stream: Record<string, string>;
}

export interface LokiQueryResponse {
    status: 'success' | 'error';
    data: {
        resultType: 'streams';
        result: LokiStreamValue[];
    };
    error?: string;
}

export declare const LOG_SUPPORTED_METRICS: readonly ["log_rate", "error_log_rate", "log_volume", "log_lines", "log_clusters"];
export type LogMetric = (typeof LOG_SUPPORTED_METRICS)[number];
//# sourceMappingURL=types.d.ts.map