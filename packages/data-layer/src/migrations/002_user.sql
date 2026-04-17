-- Migration 002: user
--
-- Grafana ref: pkg/services/sqlstore/migrations/user_mig.go
-- See docs/auth-perm-design/01-database-schema.md §user
--
-- Service accounts are rows with is_service_account=1. Same table,
-- same FKs, gated by the boolean flag per Grafana's convention.
--
-- [openobs-deviation] Primary key is TEXT (uuid) instead of BIGSERIAL.
-- [openobs-deviation] Timestamp columns are TEXT (ISO-8601) instead of TIMESTAMP.
-- [openobs-deviation] `salt` column preserved for ORM parity but unused;
--   scrypt format embeds the salt into `password`.

CREATE TABLE IF NOT EXISTS user (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL DEFAULT 0,
  email                 TEXT NOT NULL,
  name                  TEXT NOT NULL,
  login                 TEXT NOT NULL,
  password              TEXT NULL,
  salt                  TEXT NULL,
  rands                 TEXT NULL,
  company               TEXT NULL,
  org_id                TEXT NOT NULL,
  is_admin              INTEGER NOT NULL DEFAULT 0,
  email_verified        INTEGER NOT NULL DEFAULT 0,
  theme                 TEXT NULL,
  help_flags1           INTEGER NOT NULL DEFAULT 0,
  is_disabled           INTEGER NOT NULL DEFAULT 0,
  is_service_account    INTEGER NOT NULL DEFAULT 0,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  last_seen_at          TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_login ON user(login);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_email ON user(email);
CREATE INDEX IF NOT EXISTS ix_user_org_id ON user(org_id);
CREATE INDEX IF NOT EXISTS ix_user_is_service_account ON user(is_service_account);
