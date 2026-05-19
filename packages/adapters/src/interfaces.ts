/**
 * Canonical source-agnostic adapter interfaces consumed by the orchestrator
 * and the in-process registry. Concrete implementations (PrometheusMetricsAdapter,
 * LokiLogsAdapter, DuckDuckGoSearchAdapter, etc.) live in this same package and
 * implement these interfaces directly.
 *
 * These interfaces previously lived in @agentic-obs/agent-core; they were moved
 * here so adapter implementations can `implements` them without an awkward
 * back-reference to agent-core.
 */

// -- Metrics -----------------------------------------------------------------

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
  timestamp: number;
}

export interface RangeResult {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface MetricMetadata {
  type: string;
  help: string;
  unit: string;
}

export interface IMetricsAdapter {
  listMetricNames(): Promise<string[]>;
  listLabels(metric: string): Promise<string[]>;
  listLabelValues(label: string): Promise<string[]>;
  findSeries(matchers: string[]): Promise<string[]>;
  /**
   * Variant of `findSeries` that returns the FULL label-set per series rather
   * than just deduped metric names. Used by the agent's discovery tools
   * (cardinality, sample, find-related) where the label values matter. The
   * optional `limit` caps the result count at the transport layer when the
   * backend supports it; the adapter MUST still tolerate `limit=undefined`
   * by returning everything and letting the caller truncate.
   */
  findSeriesFull(matchers: string[], limit?: number): Promise<Array<Record<string, string>>>;
  fetchMetadata(metricNames?: string[]): Promise<Record<string, MetricMetadata>>;
  instantQuery(expr: string, time?: Date): Promise<MetricSample[]>;
  rangeQuery(expr: string, start: Date, end: Date, step: string): Promise<RangeResult[]>;
  testQuery(expr: string): Promise<{ ok: boolean; error?: string }>;
  isHealthy(): Promise<boolean>;
}

// -- Logs --------------------------------------------------------------------

/**
 * Source-agnostic logs adapter interface.
 *
 * Backends (Loki, Elasticsearch, CloudWatch Logs, etc.) implement this. The
 * `query` field is intentionally backend-native (e.g. LogQL for Loki, ES query
 * DSL for Elasticsearch) — translation, if any, happens above this layer.
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

// -- Changes -----------------------------------------------------------------

/**
 * Source-agnostic change-event adapter interface.
 *
 * A "change" is anything that may explain a metric/log anomaly: deploys,
 * config rollouts, feature-flag flips, manually logged incidents, etc.
 */

export type ChangeKind =
  | 'deploy'
  | 'config'
  | 'feature-flag'
  | 'incident'
  | 'other';

export interface ChangeRecord {
  id: string;
  service: string;
  kind: ChangeKind;
  summary: string;
  /** ISO-8601 timestamp when the change took effect. */
  at: string;
  metadata?: Record<string, unknown>;
}

export interface ChangesListInput {
  /** Optional service filter. Omit to fetch across all services. */
  service?: string;
  /** Look back this many minutes from now. */
  windowMinutes: number;
}

export interface IChangesAdapter {
  listRecent(input: ChangesListInput): Promise<ChangeRecord[]>;
}

// -- Web search --------------------------------------------------------------

export interface WebSearchResult {
  title?: string;
  snippet: string;
  url?: string;
}

export interface IWebSearchAdapter {
  search(query: string, maxResults?: number): Promise<WebSearchResult[]>;
}
