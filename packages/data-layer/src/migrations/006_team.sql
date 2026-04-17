-- Migration 006: team
--
-- Grafana ref: pkg/services/sqlstore/migrations/team_mig.go
-- See docs/auth-perm-design/01-database-schema.md §team

CREATE TABLE IF NOT EXISTS team (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  name                  TEXT NOT NULL,
  email                 TEXT NULL,
  external              INTEGER NOT NULL DEFAULT 0,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_org_name ON team(org_id, name);
CREATE INDEX IF NOT EXISTS ix_team_org_id ON team(org_id);
