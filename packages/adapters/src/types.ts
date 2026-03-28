// Adapter interface types for Agentic Observability data source layer

export type SignalType = 'metrics' | 'logs' | 'traces' | 'events' | 'changes';

export type AggregationFunction = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'rate' | 'p50' | 'p90' | 'p95' | 'p99';

export type TimeGranularity = '1s' | '10s' | '15s' | '30s' | '1m' | '5m' | '10m' | '1h' | '1d';

// -- SemanticQuery

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface Aggregation {
  function: AggregationFunction;
  groupBy?: string[];
  interval?: TimeGranularity;
}

export interface SemanticQuery {
  /** The entity being queried (service name, host, endpoint, etc.) */
  entity: string;
  /** Semantic metric name (e.g. "error_rate", "p95_latency", "request_rate") */
  metric: string;
  timeRange: TimeRange;
  /** Label/dimension filters keyed by name */
  filters?: Record<string, string | string[]>;
  aggregation?: Aggregation;
  /** Max number of data points to return */
  limit?: number;
}

// -- StructuredResult

export interface ResultMetadata {
  adapterName: string;
  signalType: SignalType;
  /** ISO-8601 timestamp of when the query was executed */
  executedAt: string;
  /** Actual time range covered by the returned data */
  coveredRange?: TimeRange;
  /** Whether the result is a partial response (e.g. some shards timed out) */
  partial: boolean;
  warnings?: string[];
}

export interface ResultCost {
  /** Estimated number of data points scanned */
  pointsScanned?: number;
  /** Wall-clock query duration in milliseconds */
  durationMs: number;
  /** Estimated bytes returned */
  bytesReturned?: number;
}

export interface StructuredResult<T = unknown> {
  data: T;
  metadata: ResultMetadata;
  /** The concrete backend query that was executed (e.g. PromQL expression) */
  queryUsed: string;
  cost: ResultCost;
}

// -- Capabilities

export interface DimensionDefinition {
  name: string;
  description?: string;
  values?: string[];
}

export interface Capabilities {
  /** List of semantic metric names this adapter can serve */
  supportedMetrics: string[];
  /** Finest granularity available */
  timeGranularity: TimeGranularity;
  /** Available label/tag dimensions */
  dimensions: DimensionDefinition[];
  supportedSignalTypes: SignalType[];
  supportsStreaming: boolean;
  supportsHistoricalQuery: boolean;
  /** Max lookback window in seconds */
  maxLookbackSeconds?: number;
}

// -- EventStream

export interface StreamSubscription {
  signalType: SignalType;
  entity?: string;
  filters?: Record<string, string>;
}

export interface StreamEvent<T = unknown> {
  timestamp: string;
  signalType: SignalType;
  source: string;
  payload: T;
}

export type EventStream<T = unknown> = AsyncIterable<StreamEvent<T>>;

// -- Health

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable';

export interface AdapterHealth {
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
  checkedAt: string;
}