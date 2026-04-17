-- Migration 014: audit_log
--
-- Grafana ref: Grafana Enterprise pkg/services/auditlog/ (conceptual only).
-- See docs/auth-perm-design/01-database-schema.md §audit_log
--
-- No FKs: actor/target may reference rows that later get deleted; the audit
-- row must remain readable. actor_name / target_name are denormalized for
-- the same reason.
--
-- [openobs-deviation] `timestamp` is TEXT ISO-8601 (openobs convention),
--   not INTEGER epoch millis, despite the design doc writing INTEGER.

CREATE TABLE IF NOT EXISTS audit_log (
  id                    TEXT PRIMARY KEY,
  timestamp             TEXT NOT NULL,
  action                TEXT NOT NULL,
  actor_type            TEXT NOT NULL,
  actor_id              TEXT NULL,
  actor_name            TEXT NULL,
  org_id                TEXT NULL,
  target_type           TEXT NULL,
  target_id             TEXT NULL,
  target_name           TEXT NULL,
  outcome               TEXT NOT NULL,
  metadata              TEXT NULL,
  ip                    TEXT NULL,
  user_agent            TEXT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS ix_audit_log_target_id ON audit_log(target_id);
CREATE INDEX IF NOT EXISTS ix_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS ix_audit_log_org_id ON audit_log(org_id);
