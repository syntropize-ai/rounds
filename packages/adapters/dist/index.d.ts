export type { SignalType, AggregationFunction, TimeGranularity, 
  TimeRange, Aggregation, SemanticQuery, ResultMetadata, ResultCost,
  StructuredResult, Capabilities, DimensionDefinition, StreamSubscription,
  StreamEvent, EventStream, HealthStatus, AdapterHealth, } from './types.js';
export type { DataAdapter } from './adapter.js';
export { AdapterRegistry } from './registry.js';
export type { AdapterRegistration } from './registry.js';
export { ChangeEventAdapter } from './change-event/index.js';
export type { ChangeEventAdapterConfig, ChangeQuery, WebhookPayload,
  GenericWebhookPayload, GitHubDeploymentPayload } from './change-event/index.js';
export { ChangeEventStore, normalizeWebhook } from './change-event/index.js';
export * from './prometheus/index.js';
export * from './trace/index.js';
export * from './log/index.js';
export * from './execution/index.js';