-- Migration 020: drop the legacy dashboard_messages table.
--
-- The chat path keyed on dashboardId (POST /api/dashboards/:id/chat) was
-- removed; the canonical chat surface (POST /api/chat) now persists every
-- user / assistant turn into chat_messages keyed by sessionId. This migration
-- backfills any rows that existed only in dashboard_messages into
-- chat_messages (mapping dashboard_messages.dashboard_id ->
-- dashboards.session_id) and then drops the legacy table.
--
-- The backfill is idempotent on (session_id, role, content, created_at) so
-- replays are safe. Rows whose owning dashboard has no session_id are dropped
-- with the table — they belong to the pre-session-mode era and have no place
-- to land in the new schema.

INSERT INTO chat_messages (id, session_id, role, content, actions, timestamp)
SELECT
  dm.id,
  d.session_id,
  dm.role,
  dm.content,
  dm.actions,
  dm.timestamp
FROM dashboard_messages dm
JOIN dashboards d ON d.id = dm.dashboard_id
WHERE d.session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chat_messages cm
    WHERE cm.session_id = d.session_id
      AND cm.role = dm.role
      AND cm.content = dm.content
      AND cm.timestamp = dm.timestamp
  );

DROP INDEX IF EXISTS dashboard_messages_dashboard_idx;
DROP INDEX IF EXISTS dashboard_messages_org_idx;
DROP INDEX IF EXISTS ix_dashboard_messages_org_id;
DROP TABLE IF EXISTS dashboard_messages;
