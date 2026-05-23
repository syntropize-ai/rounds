import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from './sqlite-client.js';

/**
 * Locate `sqlite-schema.sql` next to this module. In dev (tsx, src tree) the
 * file sits alongside the .ts source; in built dist the .sql isn't copied by
 * tsc, so we fall back to the sibling src tree.
 */
function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'sqlite-schema.sql'),
    join(here, '..', '..', 'src', 'db', 'sqlite-schema.sql'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8');
  }
  throw new Error(
    `[data-layer] could not locate sqlite-schema.sql. Tried: ${candidates.join(', ')}`,
  );
}

/**
 * Split a SQL script into individual statements. Strips `--` line comments
 * and skips whitespace-only chunks. Does not attempt full SQL lexing — our
 * schema is DDL + simple seed inserts with no string literals containing
 * semicolons.
 */
export function splitSqlStatements(script: string): string[] {
  const sansComments = script
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');

  return sansComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Create every table and index defined in `sqlite-schema.sql`. Idempotent —
 * every statement is `CREATE ... IF NOT EXISTS`, so calling it on an
 * already-built database is a no-op.
 */
export function applySchema(db: SqliteClient): void {
  // One-shot rename for instances created before the `user` -> `users` rename.
  // Runs before CREATE TABLE IF NOT EXISTS so the existing data is preserved
  // instead of a fresh empty `users` table appearing alongside it.
  renameLegacyUserTable(db);
  const statements = splitSqlStatements(loadSchemaSql());
  for (const stmt of statements) {
    db.run(sql.raw(stmt));
  }
  // Additive migrations after CREATE TABLE IF NOT EXISTS — these handle
  // columns added to existing tables on already-built databases. Each
  // step is idempotent and inspects sqlite_master / pragma first.
  addProvenanceColumnIfMissing(db);
  migrateConnectorTeamPoliciesToConnectorPolicies(db);
}

function renameLegacyUserTable(db: SqliteClient): void {
  const rows = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user','users')`,
  );
  const names = new Set(rows.map((r) => r.name));
  if (names.has('user') && !names.has('users')) {
    db.run(sql.raw('ALTER TABLE user RENAME TO users'));
  }
}

/**
 * Add the optional `provenance` JSON column to `investigation_reports` for
 * databases created before Task 10. New columns are nullable so existing
 * rows (no provenance to backfill) keep working — the UI's
 * <ProvenanceHeader /> already degrades to "—" for null fields.
 */
/**
 * Migrate the old `connector_team_policies` (keyed by team_id, with both
 * human_policy + agent_policy and a 4-state human policy) into the new
 * `connector_policies` (keyed by subject_type/subject_id, human_policy
 * collapsed to allow|ask|block, agent_policy removed).
 *
 * Wildcard rows (team_id = '') become `subject_type='org'` keyed by the
 * connector's org_id (looked up via JOIN). Non-empty team_id rows become
 * `subject_type='team'`. Migration runs only when the old table exists
 * AND the new one is empty so it is one-pass + idempotent.
 */
function migrateConnectorTeamPoliciesToConnectorPolicies(db: SqliteClient): void {
  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('connector_team_policies', 'connector_policies')`,
  );
  const names = new Set(tables.map((r) => r.name));
  if (!names.has('connector_team_policies')) return;
  // New table is guaranteed to exist (created by applySchema above).
  const existing = db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM connector_policies`,
  );
  if ((existing[0]?.n ?? 0) > 0) {
    // New table already populated — drop the old table and stop.
    db.run(sql.raw('DROP TABLE connector_team_policies'));
    return;
  }
  db.run(sql.raw(`
    INSERT INTO connector_policies (
      connector_id, subject_type, subject_id, capability, scope, human_policy
    )
    SELECT
      p.connector_id,
      CASE WHEN p.team_id = '' THEN 'org' ELSE 'team' END,
      CASE WHEN p.team_id = '' THEN c.org_id ELSE p.team_id END,
      p.capability,
      p.scope,
      CASE p.human_policy
        WHEN 'allow' THEN 'allow'
        WHEN 'confirm' THEN 'ask'
        WHEN 'strong_confirm' THEN 'ask'
        WHEN 'deny' THEN 'block'
        ELSE 'ask'
      END
    FROM connector_team_policies p
    JOIN connectors c ON c.id = p.connector_id
  `));
  db.run(sql.raw('DROP TABLE connector_team_policies'));
}

function addProvenanceColumnIfMissing(db: SqliteClient): void {
  const cols = db.all<{ name: string }>(
    sql`PRAGMA table_info('investigation_reports')`,
  );
  if (!cols.some((c) => c.name === 'provenance')) {
    db.run(sql.raw('ALTER TABLE investigation_reports ADD COLUMN provenance TEXT'));
  }
}
