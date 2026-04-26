// Re-export the canonical metrics adapter interface from @agentic-obs/adapters.
// Kept here for backwards-compat with code that still imports from agent-core.

export type {
  IMetricsAdapter,
  MetricSample,
  MetricMetadata,
  RangeResult,
} from '@agentic-obs/adapters';
