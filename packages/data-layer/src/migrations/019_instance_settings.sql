-- Migration 019: instance-scoped settings (LLM, datasources, notifications, KV).
--
-- Replaces the flat `<DATA_DIR>/setup-config.json` file that Wave 1 used to
-- hold setup wizard state. Moving this into SQLite gives us:
--   - transactional writes (no more half-written JSON after a crash)
--   - audit-trail hooks via `updated_by`
--   - at-rest encryption for secrets via the `encrypt`/`decrypt` helpers in
--     `@agentic-obs/common/crypto` (AES-256-GCM, SECRET_KEY from env)
--   - per-org scoping for datasources + notifications (NULL = instance-global)
--
-- See docs/tech-debt-audit-plan.md §W2 for the user decisions this encodes:
--   - instance_datasources.org_id is TEXT NULL from the start (NULL =
--     instance-global). v1 has no per-org filtering, but the column is here
--     so we can add it later without another migration.
--   - Credentials are encrypted at rest with the existing SECRET_KEY.
--   - No legacy setup-config.json migration is needed — this is a fresh
--     build with no deployed instances, so the JSON-file path is being
--     deleted outright rather than migrated.
--
-- Timestamp convention: TEXT ISO-8601 to match migration 001 and the rest of
-- the openobs schema.

-- --------------------------------------------------------------------------
-- instance_llm_config — single-row table holding the active LLM config.
--
-- The `id = 'singleton'` check constraint keeps us from accidentally ending
-- up with two rows via a bad UPSERT. All reads use `WHERE id = 'singleton'`.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance_llm_config (
  id         TEXT PRIMARY KEY CHECK (id = 'singleton'),
  provider   TEXT NOT NULL,
  api_key    TEXT NULL,        -- AES-256-GCM ciphertext (iv:ct:tag hex), nullable for providers that don't need one (ollama, aws-bedrock w/ IAM)
  model      TEXT NOT NULL,
  base_url   TEXT NULL,
  auth_type  TEXT NULL,        -- 'api-key' | 'bearer' (corporate-gateway only)
  region     TEXT NULL,        -- aws-bedrock region
  updated_at TEXT NOT NULL,
  updated_by TEXT NULL         -- user_id of the writer, NULL for bootstrap writes
);

-- --------------------------------------------------------------------------
-- instance_datasources — prometheus/loki/tempo/etc. connection configs.
--
-- `org_id NULL` means instance-global (current v1 default); future per-org
-- datasources will set it. The unique index is (org_id, name) but SQLite
-- treats NULLs in a unique index as distinct, which is exactly what we want:
-- multiple NULL org_ids may share the same name as multiple non-NULL org_ids
-- each having their own "Prod Prometheus", without collision. (Note: SQLite
-- NULL-in-UNIQUE semantics are the historical Unix/ANSI behavior; Postgres
-- matches it. Operators migrating to Postgres later get the same result.)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance_datasources (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NULL,
  type        TEXT NOT NULL,    -- loki|elasticsearch|clickhouse|tempo|jaeger|otel|prometheus|victoria-metrics
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  environment TEXT NULL,
  cluster     TEXT NULL,
  label       TEXT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  api_key     TEXT NULL,        -- AES-256-GCM ciphertext
  username    TEXT NULL,        -- plaintext (not a secret on its own)
  password    TEXT NULL,        -- AES-256-GCM ciphertext
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_instance_datasources_org_name
  ON instance_datasources(org_id, name);

CREATE INDEX IF NOT EXISTS ix_instance_datasources_org_id
  ON instance_datasources(org_id);

CREATE INDEX IF NOT EXISTS ix_instance_datasources_type
  ON instance_datasources(type);

-- --------------------------------------------------------------------------
-- notification_channels — slack/pagerduty/email webhooks.
--
-- `config` is a JSON blob. Secret fields inside it (slack webhook URL,
-- pagerduty integration key, smtp password, etc.) are encrypted individually
-- by the repository layer before the JSON is serialized; non-secret fields
-- (smtp host, port, from) remain plaintext for debuggability. This lets us
-- mask only what needs masking on read.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_channels (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NULL,
  type       TEXT NOT NULL,     -- slack|pagerduty|email
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,     -- JSON with encrypted secret fields
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_notification_channels_org_id
  ON notification_channels(org_id);

CREATE INDEX IF NOT EXISTS ix_notification_channels_type
  ON notification_channels(type);

-- --------------------------------------------------------------------------
-- instance_settings — generic KV bag for one-shot bootstrap flags.
--
-- Reserved keys (written by the gateway, do not stomp manually):
--   - bootstrapped_at            ISO-8601 time of the first successful admin
--                                creation. Once set, the /api/setup bootstrap
--                                gate locks permanently even if users table
--                                is cleared. See T2.7.
--   - configured_at              ISO-8601 time setup last reached "ready"
--                                state (hasAdmin && hasLLM). Derived, not a
--                                source of truth; kept as a breadcrumb.
--
-- Distinct from `_runtime_settings` (migration 018): that table is internal
-- (prefixed `_`) and holds strictly internal markers like `auth_migrated_v1`.
-- `instance_settings` is user-visible configuration state.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
