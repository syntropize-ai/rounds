// Runtime config for openobs lives in SQLite — per-org `instance_settings`
// and `preferences`, plus the instance-scoped `instance_llm_config`,
// and `notification_channels` tables added in
// migration 019. The YAML/dotenv `ConfigLoader` + `AppConfigSchema` that
// used to live here was never wired into the running server — only its own
// test consumed it — so it was removed to stop the Node-only `dotenv` +
// `fs` imports from leaking into the web bundle via the
// `@agentic-obs/common` barrel.

export { DEFAULT_LLM_MODEL } from './model-defaults.js';
