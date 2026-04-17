-- Migration 008: api_key
--
-- Grafana ref: pkg/services/sqlstore/migrations/apikey_mig.go
-- See docs/auth-perm-design/01-database-schema.md §api_key
-- See docs/auth-perm-design/06-service-accounts.md for the extra owner_user_id field.
--
-- - service_account_id NULL  => personal access token.
-- - service_account_id NOT NULL => service-account token.
-- - `key` stores SHA-256 hex of the token (never the plaintext).
-- - owner_user_id is the user who created the token (openobs addition); for
--   SA tokens both columns are populated — service_account_id points to the SA
--   user row, owner_user_id to the operator who minted it.

CREATE TABLE IF NOT EXISTS api_key (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  name                  TEXT NOT NULL,
  key                   TEXT NOT NULL,
  role                  TEXT NOT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  last_used_at          TEXT NULL,
  expires               TEXT NULL,
  service_account_id    TEXT NULL,
  owner_user_id         TEXT NULL,
  is_revoked            INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id)             REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (service_account_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id)      REFERENCES user(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_key_key ON api_key(key);
CREATE INDEX IF NOT EXISTS ix_api_key_org_id ON api_key(org_id);
CREATE INDEX IF NOT EXISTS ix_api_key_service_account_id ON api_key(service_account_id);
CREATE INDEX IF NOT EXISTS ix_api_key_owner_user_id ON api_key(owner_user_id);
