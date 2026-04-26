-- Migration 021: backfill resource workspace ownership from org_id.
--
-- API routes now enforce resource ownership with strict workspace_id checks.
-- Existing rows created before the org/resource cutover can have NULL
-- workspace_id even though migration 015 added a concrete org_id. Backfill the
-- ownership column explicitly instead of reintroducing route-level defaults.

UPDATE dashboards
SET workspace_id = org_id
WHERE workspace_id IS NULL;

UPDATE investigations
SET workspace_id = org_id
WHERE workspace_id IS NULL;

UPDATE incidents
SET workspace_id = org_id
WHERE workspace_id IS NULL;

UPDATE alert_rules
SET workspace_id = org_id
WHERE workspace_id IS NULL;
