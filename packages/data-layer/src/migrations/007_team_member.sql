-- Migration 007: team_member
--
-- Grafana ref: pkg/services/sqlstore/migrations/team_member_mig.go
-- See docs/auth-perm-design/01-database-schema.md §team_member
--
-- `permission` is integer-encoded per Grafana: 0=Member, 4=Admin (team admin).

CREATE TABLE IF NOT EXISTS team_member (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  team_id               TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  external              INTEGER NOT NULL DEFAULT 0,
  permission            INTEGER NOT NULL DEFAULT 0,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_member_team_user ON team_member(team_id, user_id);
CREATE INDEX IF NOT EXISTS ix_team_member_user_id ON team_member(user_id);
CREATE INDEX IF NOT EXISTS ix_team_member_org_id ON team_member(org_id);
