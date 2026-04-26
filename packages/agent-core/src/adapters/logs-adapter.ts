// Re-export the canonical logs adapter interface from @agentic-obs/adapters.
// Kept here for backwards-compat with code that still imports from agent-core.

export type {
  ILogsAdapter,
  LogEntry,
  LogsQueryInput,
  LogsQueryResult,
} from '@agentic-obs/adapters';
