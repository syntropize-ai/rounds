// @agentic-obs/adapters - Data source adapter interfaces and implementations

// -- Canonical adapter interfaces (consumed by orchestrator + AdapterRegistry) --
export type {
  IMetricsAdapter,
  MetricSample,
  MetricMetadata,
  RangeResult,
  ILogsAdapter,
  LogEntry,
  LogsQueryInput,
  LogsQueryResult,
  IChangesAdapter,
  ChangeKind,
  ChangeRecord,
  ChangesListInput,
  IWebSearchAdapter,
  WebSearchResult,
} from './interfaces.js';

// -- Canonical concrete implementations --
export { PrometheusMetricsAdapter } from './prometheus/metrics-adapter.js';
export { LokiLogsAdapter } from './loki/logs-adapter.js';
export { DuckDuckGoSearchAdapter } from './web-search/duckduckgo-adapter.js';

// -- Prometheus client + helpers (used by api-gateway query route) --
export { PrometheusHttpClient } from './prometheus/client.js';
export type { IPrometheusClient } from './prometheus/client.js';
export * from './prometheus/types.js';
export * from './prometheus/translator.js';

// -- Legacy DataAdapter abstraction (only ChangeEventAdapter still uses it) --
export type {
  SignalType,
  AggregationFunction,
  TimeGranularity,
  TimeRange,
  Aggregation,
  SemanticQuery,
  ResultMetadata,
  ResultCost,
  StructuredResult,
  Capabilities,
  DimensionDefinition,
  StreamSubscription,
  StreamEvent,
  EventStream,
  HealthStatus,
  AdapterHealth,
} from './types.js';
export type { DataAdapter, AdapterErrorKind } from './adapter.js';
export { AdapterError, classifyAdapterHttpError } from './adapter.js';
export { AdapterRegistry } from './registry.js';
export type { AdapterRegistration } from './registry.js';

// -- Change-event adapter (DataAdapter-shaped, includes webhook ingestion) --
export { ChangeEventAdapter } from './change-event/index.js';
export type { ChangeEventAdapterConfig, ChangeQuery, WebhookPayload,
  GenericWebhookPayload, GitHubDeploymentPayload } from './change-event/index.js';
export { ChangeEventStore, normalizeWebhook } from './change-event/index.js';

// -- Execution adapter --
export * from './execution/index.js';
