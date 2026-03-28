// Log Adapter - domain types for log querying and clustering
// — Supported semantic metric names ——————————————————————————————————————————
export const LOG_SUPPORTED_METRICS = [
    'log_rate',        // count of log lines per time window
    'error_log_rate',  // count of error/fatal lines per time window
    'log_volume',      // total bytes of log data
    'log_lines',       // raw log retrieval
    'log_clusters',    // clustered log patterns
];
//# sourceMappingURL=types.js.map