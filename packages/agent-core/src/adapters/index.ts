export type { IWebSearchAdapter, WebSearchResult } from './web-search-adapter.js';
export type { IMetricsAdapter, MetricSample, MetricMetadata, RangeResult } from './metrics-adapter.js';
export type {
  ILogsAdapter,
  LogEntry,
  LogsQueryInput,
  LogsQueryResult,
} from './logs-adapter.js';
export type {
  IChangesAdapter,
  ChangeKind,
  ChangeRecord,
  ChangesListInput,
} from './changes-adapter.js';
export type {
  AdapterEntry,
  DatasourceInfo,
  SignalType,
} from './registry.js';
export { AdapterRegistry } from './registry.js';
