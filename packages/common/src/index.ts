// @agentic-obs/common — shared types and FRONTEND-SAFE utilities.
//
// BOUNDARY RULE: this barrel must be importable from the web bundle without
// pulling Node built-ins (fs, node:async_hooks, node:crypto, …) or Node-only
// packages (pino, ioredis, bullmq, dotenv). Anything that does is exported
// from an explicit subpath instead — see package.json "exports":
//
//   @agentic-obs/common              ← this file. Safe everywhere.
//   @agentic-obs/common/logging      ← createLogger, requestLogger, correlation
//   @agentic-obs/common/crypto       ← AES-GCM secret box, node:crypto
//   @agentic-obs/common/queue        ← BullMQ worker queue, ioredis
//   @agentic-obs/common/events/redis ← Redis event bus adapter
//   @agentic-obs/common/config/loader← fs/dotenv config loader
//
// Tests on this file live in the corresponding sub-module directories.
// Adding a re-export to this barrel that drags a Node module into the web
// bundle will reintroduce the __vite-browser-external runtime crash —
// `packages/web` will fail to load in the browser.

export * from './types.js';
export * from './errors/index.js';
export * from './models/index.js';
export * from './repositories/index.js';
export * from './adapter-types.js';

// Auth / perm types + pure helpers.
export * from './auth/index.js';
export * from './audit/index.js';
export * from './rbac/index.js';

// Config: only the browser-safe schema + model defaults. ConfigLoader is
// server-only and lives at @agentic-obs/common/config/loader.
export {
  AppConfigSchema,
  type AppConfig,
  type ConfigLoaderOptions,
  DEFAULT_LLM_MODEL,
} from './config/index.js';

// Lifecycle: graceful-shutdown hooks use node:process signals — server only.
// Imported via @agentic-obs/common/lifecycle subpath.

// Event bus types + constants are pure (no Node deps); the concrete
// Redis/InMemory implementations live at @agentic-obs/common/events/redis
// and @agentic-obs/common/events (the `factory` entry). Re-exporting just
// the type surface here keeps consumers like `websocket/gateway` able to
// grep EventTypes without pulling ioredis into the web bundle.
export { EventTypes, type EventType, type EventEnvelope } from './events/types.js';
export type { IEventBus, EventHandler } from './events/interface.js';
