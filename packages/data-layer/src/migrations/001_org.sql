-- Migration 001: org
--
-- Grafana ref: pkg/services/sqlstore/migrations/org_mig.go
-- See docs/auth-perm-design/01-database-schema.md §org
--
-- [openobs-deviation] Primary key is TEXT (uuid) instead of BIGSERIAL.
-- [openobs-deviation] Timestamp columns are TEXT (ISO-8601) instead of TIMESTAMP.

CREATE TABLE IF NOT EXISTS org (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL DEFAULT 0,
  name                  TEXT NOT NULL,
  address1              TEXT NULL,
  address2              TEXT NULL,
  city                  TEXT NULL,
  state                 TEXT NULL,
  zip_code              TEXT NULL,
  country               TEXT NULL,
  billing_email         TEXT NULL,
  created               TEXT NOT NULL,
  updated               TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_name ON org(name);

-- Seed default org. Fixed id 'org_main' per design doc; keeps existing
-- data that used workspace_id='main' naturally alignable during the
-- T4.5 workspace-to-org cutover.
INSERT OR IGNORE INTO org (id, name, version, created, updated) VALUES
  ('org_main', 'Main Org', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
