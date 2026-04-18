-- Migration 017: wire dashboards + alert_rules to the new folder hierarchy.
--
-- See docs/auth-perm-design/07-resource-permissions.md §dashboard-permissions
-- and §alert-rule-permissions. The folder (singular) table created in 010 is
-- the Grafana-parity hierarchical folder; existing resource tables gain a
-- `folder_uid` column so dashboards and alert rules can be placed inside a
-- folder and inherit its permissions.
--
-- Grafana has the same evolution: its dashboard + alert_rule tables grew a
-- folder_uid column when nested folders landed (pkg/services/ngalert +
-- pkg/services/dashboards). We match the column name exactly.
--
-- SQLite ALTER TABLE cannot add a FOREIGN KEY post-hoc; referential integrity
-- is enforced in application code (FolderService.delete cascades child rows).

ALTER TABLE dashboards  ADD COLUMN folder_uid TEXT NULL;
ALTER TABLE alert_rules ADD COLUMN folder_uid TEXT NULL;

CREATE INDEX IF NOT EXISTS ix_dashboards_folder_uid  ON dashboards(org_id, folder_uid);
CREATE INDEX IF NOT EXISTS ix_alert_rules_folder_uid ON alert_rules(org_id, folder_uid);
