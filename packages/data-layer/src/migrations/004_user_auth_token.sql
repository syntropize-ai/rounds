-- Migration 004: user_auth_token
--
-- Grafana ref: pkg/services/sqlstore/migrations/user_auth_token_mig.go
-- See docs/auth-perm-design/01-database-schema.md §user_auth_token
--
-- Server-side session record. Tokens are never stored unhashed; we keep the
-- SHA-256 hex digest. Rotation grace window is implemented via prev_auth_token.
--
-- [openobs-deviation] Primary key is TEXT (uuid).
-- [openobs-deviation] Timestamps are TEXT ISO-8601 except auth_token_seen which
--   remains an INTEGER 0/1 boolean per Grafana (see user_auth_token.go).

CREATE TABLE IF NOT EXISTS user_auth_token (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  auth_token            TEXT NOT NULL,
  prev_auth_token       TEXT NOT NULL,
  user_agent            TEXT NOT NULL,
  client_ip             TEXT NOT NULL,
  auth_token_seen       INTEGER NOT NULL DEFAULT 0,
  seen_at               TEXT NULL,
  rotated_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  revoked_at            TEXT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_auth_token_authtoken ON user_auth_token(auth_token);
CREATE INDEX IF NOT EXISTS ix_user_auth_token_user_id ON user_auth_token(user_id);
CREATE INDEX IF NOT EXISTS ix_user_auth_token_revoked_at ON user_auth_token(revoked_at);
