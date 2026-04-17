-- Migration 011: dashboard_acl (legacy ACL table kept for Grafana compat)
--
-- Grafana ref: pkg/services/sqlstore/migrations/dashboard_acl_mig.go
-- See docs/auth-perm-design/01-database-schema.md §dashboard_acl
--
-- RBAC permission rows supersede this, but Grafana keeps dashboard_acl as an
-- input view for back-compat. We mirror that. See 07-resource-permissions.md.
-- Application-layer invariant (not enforced by CHECK): exactly one of
-- (user_id, team_id, role) is non-NULL.

CREATE TABLE IF NOT EXISTS dashboard_acl (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  dashboard_id          TEXT NULL,
  folder_id             TEXT NULL,
  user_id               TEXT NULL,
  team_id               TEXT NULL,
  role                  TEXT NULL,
  permission            INTEGER NOT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_dashboard_acl_dashboard_id ON dashboard_acl(dashboard_id);
CREATE INDEX IF NOT EXISTS ix_dashboard_acl_folder_id ON dashboard_acl(folder_id);
