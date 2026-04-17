-- Migration 009: RBAC — role, permission, builtin_role, user_role, team_role
--
-- Grafana ref:
--   pkg/services/sqlstore/migrations/accesscontrol/role_mig.go
--   pkg/services/sqlstore/migrations/accesscontrol/permission_mig.go
--   pkg/services/sqlstore/migrations/accesscontrol/builtin_role_mig.go
--   pkg/services/sqlstore/migrations/accesscontrol/team_role_mig.go
--   pkg/services/sqlstore/migrations/accesscontrol/user_role_mig.go
-- See docs/auth-perm-design/01-database-schema.md §role, §permission,
-- §builtin_role, §user_role / §team_role, and §03-rbac-model.md.
--
-- NOTE: This migration only creates the tables. Seeding built-in roles and
-- their permissions (basic:viewer / basic:editor / basic:admin / basic:server_admin
-- plus all fixed roles) is T3.1's responsibility — not done here.
--
-- [openobs-deviation] org_id uses empty string '' for global roles where
--   Grafana uses int64 0.

CREATE TABLE IF NOT EXISTS role (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL DEFAULT 0,
  org_id                TEXT NOT NULL,
  name                  TEXT NOT NULL,
  uid                   TEXT NOT NULL,
  display_name          TEXT NULL,
  description           TEXT NULL,
  group_name            TEXT NULL,
  hidden                INTEGER NOT NULL DEFAULT 0,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL
  -- [openobs-deviation] No FK on role.org_id because '' (global) is a valid
  -- value that does not correspond to a row in org(id). Grafana uses org_id=0
  -- for the same purpose and likewise does not declare a hard FK for global
  -- roles (see role_mig.go).
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_role_org_name ON role(org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_org_uid ON role(org_id, uid);

CREATE TABLE IF NOT EXISTS permission (
  id                    TEXT PRIMARY KEY,
  role_id               TEXT NOT NULL,
  action                TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  attribute             TEXT NOT NULL,
  identifier            TEXT NOT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_permission_role_id ON permission(role_id);
CREATE INDEX IF NOT EXISTS ix_permission_action ON permission(action);
CREATE INDEX IF NOT EXISTS ix_permission_kind_identifier ON permission(kind, identifier);

CREATE TABLE IF NOT EXISTS builtin_role (
  id                    TEXT PRIMARY KEY,
  role                  TEXT NOT NULL,
  role_id               TEXT NOT NULL,
  org_id                TEXT NOT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_builtin_role_role_orgid ON builtin_role(role, org_id, role_id);

CREATE TABLE IF NOT EXISTS user_role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  created     TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_role ON user_role(org_id, user_id, role_id);
CREATE INDEX IF NOT EXISTS ix_user_role_user_id ON user_role(user_id);

CREATE TABLE IF NOT EXISTS team_role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  created     TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_role ON team_role(org_id, team_id, role_id);
CREATE INDEX IF NOT EXISTS ix_team_role_team_id ON team_role(team_id);
