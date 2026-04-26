-- Postgres migration 002: investigation tables and sub-entities.
--
-- Adds the `investigations` table plus its three child tables required for
-- feature parity with the SQLite repository:
--   - investigation_follow_ups   (one-to-many, cascade on parent delete)
--   - investigation_feedback     (one-to-many, cascade on parent delete)
--   - investigation_conclusions  (one-to-one via PK = investigation_id)
--
-- The parent `investigations` table also gains the `actions` JSONB column
-- and `workspace_id` text column so the rowToInvestigation mapper can return
-- real values instead of hardcoded empties.

-- --------------------------------------------------------------------------
-- investigations — primary entity.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigations (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  session_id        TEXT NULL,
  user_id           TEXT NULL,
  intent            TEXT NOT NULL,
  structured_intent JSONB NULL,
  plan              JSONB NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  hypotheses        JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  symptoms          JSONB NOT NULL DEFAULT '[]'::jsonb,
  workspace_id      TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ NULL
);

-- For pre-existing deployments where 002 ran on top of an older
-- `investigations` table that lacks these columns.
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS workspace_id TEXT NULL;

CREATE INDEX IF NOT EXISTS investigations_tenant_idx        ON investigations(tenant_id);
CREATE INDEX IF NOT EXISTS investigations_session_idx       ON investigations(session_id);
CREATE INDEX IF NOT EXISTS investigations_status_idx        ON investigations(status);
CREATE INDEX IF NOT EXISTS investigations_workspace_idx     ON investigations(workspace_id);
CREATE INDEX IF NOT EXISTS investigations_created_at_idx    ON investigations(created_at);

-- --------------------------------------------------------------------------
-- investigation_follow_ups — one-to-many follow-up questions per
-- investigation. ON DELETE CASCADE so deleting a parent investigation
-- removes its follow-ups.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigation_follow_ups (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  question         TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investigation_follow_ups_investigation_idx
  ON investigation_follow_ups(investigation_id);

CREATE INDEX IF NOT EXISTS investigation_follow_ups_created_at_idx
  ON investigation_follow_ups(created_at);

-- --------------------------------------------------------------------------
-- investigation_feedback — one-to-many user feedback per investigation.
-- `helpful` is a real boolean (vs the SQLite 0/1 integer); JSONB used for
-- the per-hypothesis / per-action breakdown arrays.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigation_feedback (
  id                    TEXT PRIMARY KEY,
  investigation_id      TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  helpful               BOOLEAN NOT NULL,
  comment               TEXT NULL,
  root_cause_verdict    TEXT NULL,
  hypothesis_feedbacks  JSONB NULL,
  action_feedbacks      JSONB NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investigation_feedback_investigation_idx
  ON investigation_feedback(investigation_id);

CREATE INDEX IF NOT EXISTS investigation_feedback_created_at_idx
  ON investigation_feedback(created_at);

-- --------------------------------------------------------------------------
-- investigation_conclusions — one-to-one (PK = investigation_id) so a
-- parent investigation has at most one conclusion. Upserts use
-- ON CONFLICT(investigation_id).
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigation_conclusions (
  investigation_id TEXT PRIMARY KEY REFERENCES investigations(id) ON DELETE CASCADE,
  conclusion       JSONB NOT NULL
);
