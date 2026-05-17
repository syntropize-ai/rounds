// @agentic-obs/common — shared types and FRONTEND-SAFE utilities.
//
// BOUNDARY RULE: this barrel must be importable from the web bundle without
// pulling Node built-ins (fs, node:async_hooks, node:crypto, …) or Node-only
// packages (ioredis, bullmq, dotenv). Server-only modules previously hosted
// here (logging, crypto, lifecycle, redis event bus) now live in
// `@agentic-obs/server-utils`. Subpaths that remain here:
//
//   @agentic-obs/common              ← this file. Safe everywhere.
//   @agentic-obs/common/queue        ← BullMQ worker queue, ioredis (server only)
//   @agentic-obs/common/events       ← pure event types + InMemory bus + fingerprint
//
// Tests on this file live in the corresponding sub-module directories.
// Adding a re-export to this barrel that drags a Node module into the web
// bundle will reintroduce the __vite-browser-external runtime crash —
// `packages/web` will fail to load in the browser. An ESLint
// `no-restricted-imports` rule on packages/common/src/** blocks new
// server-only imports (see .eslintrc.cjs).

export * from './types.js';
export * from './errors/index.js';
export * from './models/index.js';
export * from './repositories/index.js';
export * from './adapter-types.js';
export * from './resources/index.js';

// Auth / perm types + pure helpers.
export * from './auth/index.js';
export * from './audit/index.js';
export * from './rbac/index.js';

// Config: only the model-defaults constant. The legacy YAML+dotenv
// `ConfigLoader` and its Zod `AppConfigSchema` were never wired into
// the running server and have been removed — runtime config lives in
// SQLite (org_user, preferences, instance_settings, instance_llm_config,
// notification_channels).
export { DEFAULT_LLM_MODEL } from './config/index.js';

// Event bus types + constants are pure (no Node deps); the concrete
// Redis adapter + env-driven factory live at @agentic-obs/server-utils/events.
// Re-exporting just the type surface here keeps consumers like
// `websocket/gateway` able to grep EventTypes without pulling ioredis into
// the web bundle.
export { EventTypes, type EventType, type EventEnvelope } from './events/types.js';
export type { IEventBus, EventHandler } from './events/interface.js';

// Pure utility helpers. `chart-summary` is consumed by both the REST
// /api/metrics/query endpoint and the agent `metric_explore` tool.
export { summarize as summarizeChart } from './utils/chart-summary.js';
export type {
  ChartMetricKind,
  ChartSummary,
  SummarySeries,
} from './utils/chart-summary.js';
export { suggestPivots } from './utils/chart-pivots.js';
export type { PivotSuggestion, SuggestPivotsArgs } from './utils/chart-pivots.js';

// Knowledge base — TF-IDF, bundled seeds, and the IKnowledgeRepository surface
// the agent handlers / loader / template route consume. The repository
// interface here is the contract; B1's data-layer implementation will satisfy
// it. When B1's types land in @agentic-obs/data-layer, this re-export can
// either delegate to those (one-line change) or be removed.
export * from './kb/index.js';
