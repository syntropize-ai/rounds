-- Migration 013: quota
--
-- Grafana ref: pkg/services/sqlstore/migrations/quota_mig.go
-- See docs/auth-perm-design/01-database-schema.md §quota
--
-- SQLite partial indexes (WHERE clause) are supported since 3.8; our
-- better-sqlite3 ships a newer engine so this is safe.
--
-- Exactly one of (org_id, user_id) is non-NULL. target is one of
-- 'dashboards' | 'users' | 'datasources' | 'api_keys' | 'service_accounts'
-- | 'folders' | 'alert_rules'. limit_val = -1 means unlimited.

CREATE TABLE IF NOT EXISTS quota (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NULL,
  user_id     TEXT NULL,
  target      TEXT NOT NULL,
  limit_val   INTEGER NOT NULL,
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL
  -- [openobs-deviation] No FK on org_id/user_id because one is always NULL;
  -- the partial unique indexes below still enforce the invariant.
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_quota_org_target
  ON quota(org_id, target) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_quota_user_target
  ON quota(user_id, target) WHERE org_id IS NULL;
