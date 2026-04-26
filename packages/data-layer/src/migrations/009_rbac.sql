-- Migration 009: RBAC schema — role, permission, builtin_role, user_role, team_role
--
-- Creates the relational tables that back the access-control system:
--   * role          — named bundle of permissions, scoped per-org or globally.
--   * permission    — individual (action, scope) entries owned by a role.
--   * builtin_role  — maps an org-role label (Viewer/Editor/Admin/...) to a
--                     concrete role row, so basic-role users inherit the right
--                     permission set without an explicit user_role grant.
--   * user_role     — direct grant of a role to a single user in an org.
--   * team_role     — direct grant of a role to a team in an org.
--
-- See docs/auth-perm-design/01-database-schema.md §role, §permission,
-- §builtin_role, §user_role / §team_role, and §03-rbac-model.md for the
-- design rationale.
--
-- NOTE: This migration only creates the tables. Seeding the built-in roles and
-- their permissions (basic:viewer / basic:editor / basic:admin /
-- basic:server_admin plus the fixed-role catalog) happens at startup in
-- application code, not here.
--
-- [openobs-deviation] org_id is TEXT and uses the empty string '' to mark a
--   role as global (i.e. not bound to any specific org). All other id columns
--   are TEXT (UUID-shaped) to stay consistent with the rest of the schema.

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
  -- value that does not correspond to a row in org(id), so a hard foreign
  -- key would always fail for global roles.
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
