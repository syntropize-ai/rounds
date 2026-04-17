-- Migration 015: add org_id to existing resource tables
--
-- See docs/auth-perm-design/01-database-schema.md §"Existing openobs tables gain org_id"
-- See docs/auth-perm-design/10-migration-plan.md §T4.5 for cutover semantics.
--
-- Existing workspace_id / tenant_id columns are left in place. T4.5 will
-- backfill org_id FROM workspace_id (or tenant_id) on production data and
-- eventually drop the legacy columns. Default 'org_main' here so:
--   1. Fresh installs auto-associate everything with the default org.
--   2. Existing deployments keep working until the dual-write phase copies
--      real org_id values in.
--
-- ALTER TABLE cannot add a FOREIGN KEY in SQLite; we rely on the application
-- layer and the fact that 'org_main' always exists (migration 001) to keep
-- referential integrity.
-- [openobs-deviation] No FK on org_id column in these ALTERed tables — SQLite
--   limitation. Grafana's equivalent migrations (resource tables post-org-add)
--   don't emit FKs either; they rely on the org_user row to scope access.

ALTER TABLE dashboards             ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE dashboard_messages     ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE investigations         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE incidents              ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE feed_items             ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE alert_rules            ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE alert_history          ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE alert_silences         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE chat_sessions          ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE chat_messages          ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE chat_session_events    ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE investigation_reports  ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE post_mortems           ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';
ALTER TABLE approvals              ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';

CREATE INDEX IF NOT EXISTS ix_dashboards_org_id             ON dashboards(org_id);
CREATE INDEX IF NOT EXISTS ix_dashboard_messages_org_id     ON dashboard_messages(org_id);
CREATE INDEX IF NOT EXISTS ix_investigations_org_id         ON investigations(org_id);
CREATE INDEX IF NOT EXISTS ix_incidents_org_id              ON incidents(org_id);
CREATE INDEX IF NOT EXISTS ix_feed_items_org_id             ON feed_items(org_id);
CREATE INDEX IF NOT EXISTS ix_alert_rules_org_id            ON alert_rules(org_id);
CREATE INDEX IF NOT EXISTS ix_alert_history_org_id          ON alert_history(org_id);
CREATE INDEX IF NOT EXISTS ix_alert_silences_org_id         ON alert_silences(org_id);
CREATE INDEX IF NOT EXISTS ix_chat_sessions_org_id          ON chat_sessions(org_id);
CREATE INDEX IF NOT EXISTS ix_chat_messages_org_id          ON chat_messages(org_id);
CREATE INDEX IF NOT EXISTS ix_chat_session_events_org_id    ON chat_session_events(org_id);
CREATE INDEX IF NOT EXISTS ix_investigation_reports_org_id  ON investigation_reports(org_id);
CREATE INDEX IF NOT EXISTS ix_post_mortems_org_id           ON post_mortems(org_id);
CREATE INDEX IF NOT EXISTS ix_approvals_org_id              ON approvals(org_id);
