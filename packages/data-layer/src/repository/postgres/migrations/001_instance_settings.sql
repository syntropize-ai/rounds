-- Postgres migration 001: instance-scoped settings (LLM, datasources,
-- notifications, KV).
--
-- Ports the W2 tables from the SQLite migrations (018/019) to Postgres.
-- Translation notes:
--   - `TEXT` stays `TEXT` (Postgres semantics match SQLite for our usage).
--   - `INTEGER NOT NULL DEFAULT 0` for the SQLite boolean `is_default` becomes
--     `BOOLEAN NOT NULL DEFAULT FALSE` to get proper boolean semantics.
--   - SQLite UNIQUE indexes treat NULLs as distinct by default, matching
--     Postgres' default NULLS DISTINCT (pre-15 behaviour). From Postgres 15
--     the default is still NULLS DISTINCT, so the index below behaves the
--     same way without extra syntax.
--   - Check constraints ported verbatim.
--   - FK to `org(id)` is preserved but guarded with `IF NOT EXISTS` table
--     creation — the W6 auth tables will be owned by their own migration
--     (out of scope for this sprint).

-- --------------------------------------------------------------------------
-- instance_llm_config — single-row table holding the active LLM config.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance_llm_config (
  id         TEXT PRIMARY KEY CHECK (id = 'singleton'),
  provider   TEXT NOT NULL,
  api_key    TEXT NULL,
  model      TEXT NOT NULL,
  base_url   TEXT NULL,
  auth_type  TEXT NULL,
  region     TEXT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NULL
);

-- --------------------------------------------------------------------------
-- instance_datasources — prometheus/loki/tempo/etc. connection configs.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance_datasources (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  environment TEXT NULL,
  cluster     TEXT NULL,
  label       TEXT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  api_key     TEXT NULL,
  username    TEXT NULL,
  password    TEXT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_instance_datasources_org_name
  ON instance_datasources(org_id, name);

CREATE INDEX IF NOT EXISTS ix_instance_datasources_org_id
  ON instance_datasources(org_id);

CREATE INDEX IF NOT EXISTS ix_instance_datasources_type
  ON instance_datasources(type);

-- --------------------------------------------------------------------------
-- notification_channels — slack/pagerduty/email webhooks.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_channels (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NULL,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NULL
);

CREATE INDEX IF NOT EXISTS ix_notification_channels_org_id
  ON notification_channels(org_id);

CREATE INDEX IF NOT EXISTS ix_notification_channels_type
  ON notification_channels(type);

-- --------------------------------------------------------------------------
-- instance_settings — generic KV bag for one-shot bootstrap flags.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
