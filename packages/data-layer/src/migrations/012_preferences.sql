-- Migration 012: preferences
--
-- Grafana ref: pkg/services/sqlstore/migrations/preferences_mig.go
-- See docs/auth-perm-design/01-database-schema.md §preferences
--
-- The uniqueness invariant (org_id, user_id, team_id) is guarded by a
-- COALESCE-on-NULLs unique index so that (org, NULL, NULL) is a single row
-- rather than many (SQLite's default NULLs-distinct treatment).

CREATE TABLE IF NOT EXISTS preferences (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  user_id               TEXT NULL,
  team_id               TEXT NULL,
  version               INTEGER NOT NULL DEFAULT 0,
  home_dashboard_uid    TEXT NULL,
  timezone              TEXT NULL,
  week_start            TEXT NULL,
  theme                 TEXT NULL,
  locale                TEXT NULL,
  json_data             TEXT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_preferences_org_user_team
  ON preferences(org_id, COALESCE(user_id, ''), COALESCE(team_id, ''));
