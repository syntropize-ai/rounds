-- Migration 005: org_user
--
-- Grafana ref: pkg/services/sqlstore/migrations/org_user_mig.go
-- See docs/auth-perm-design/01-database-schema.md §org_user
--
-- Association table: (org_id, user_id) with an org-scoped role.
-- Role values are the PascalCase strings Admin / Editor / Viewer / None,
-- matching Grafana's RoleType (pkg/models/roles.go).

CREATE TABLE IF NOT EXISTS org_user (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  role                  TEXT NOT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_user_org_user ON org_user(org_id, user_id);
CREATE INDEX IF NOT EXISTS ix_org_user_user_id ON org_user(user_id);
