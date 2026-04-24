/**
 * Source-agnostic logs adapter interface.
 *
 * Backends (Loki, Elasticsearch, CloudWatch Logs, etc.) implement this in
 * package @agentic-obs/adapters. The `query` field is intentionally
 * backend-native (e.g. LogQL for Loki, ES query DSL for Elasticsearch) —
 * translation, if any, happens above this layer.
 */

export interface LogEntry {
  /** ISO-8601 timestamp of the log line. */
  timestamp: string;
  message: string;
  labels: Record<string, string>;
}

export interface LogsQueryInput {
  /** Backend-native query string (LogQL for Loki, etc.). */
  query: string;
  start: Date;
  end: Date;
  /** Maximum entries to return. Adapter default: 100. */
  limit?: number;
}

export interface LogsQueryResult {
  entries: LogEntry[];
  /** True when the backend indicated the result set was truncated. */
  partial: boolean;
  warnings?: string[];
}

export interface ILogsAdapter {
  query(input: LogsQueryInput): Promise<LogsQueryResult>;
  listLabels(): Promise<string[]>;
  listLabelValues(label: string): Promise<string[]>;
  isHealthy(): Promise<boolean>;
}
