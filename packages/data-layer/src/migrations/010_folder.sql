-- Migration 010: folder (Grafana-parity hierarchical folder)
--
-- Grafana ref: pkg/services/sqlstore/migrations/folder.go
-- See docs/auth-perm-design/01-database-schema.md §folder
--
-- This is a NEW table. An existing openobs `folders` table (flat, id/name/parent_id)
-- remains untouched until T9.6 cleanup. Cycle-detection + max-depth=8 are
-- enforced in application code (FolderRepository), per Grafana.
--
-- [openobs-deviation] Table name is `folder` (singular, Grafana name). The
--   legacy openobs `folders` table keeps its plural name for now.

CREATE TABLE IF NOT EXISTS folder (
  id                    TEXT PRIMARY KEY,
  uid                   TEXT NOT NULL,
  org_id                TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NULL,
  parent_uid            TEXT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL,
  created_by            TEXT NULL,
  updated_by            TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES user(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES user(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_folder_org_uid ON folder(org_id, uid);
CREATE INDEX IF NOT EXISTS ix_folder_parent_uid ON folder(org_id, parent_uid);
