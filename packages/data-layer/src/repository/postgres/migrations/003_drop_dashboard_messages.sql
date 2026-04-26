-- Postgres migration 003: drop the legacy dashboard_messages table.
--
-- Mirrors SQLite migration 020. See that file for the full rationale.
-- The dashboardId-keyed chat path is gone; chat_messages (sessionId-keyed)
-- is the canonical store. Backfill any orphans with a known sessionId, then
-- drop the table.

-- Postgres-side note: the W6 dashboard / chat tables are not yet created via
-- this migration set (W6 runs SQLite-only as of writing — see migrate.ts).
-- The DROP is wrapped in IF EXISTS so this migration is a no-op on instances
-- that never had dashboard_messages. We do not run the SQLite-style backfill
-- here for the same reason: chat_messages / dashboards may not exist on
-- Postgres yet, so referencing them at migration time would fail.

DROP TABLE IF EXISTS dashboard_messages;
