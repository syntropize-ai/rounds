import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from './sqlite-client.js';
import {
  CONNECTOR_SECRET_KEY_VERSION,
  CONNECTOR_SECRET_PLAINTEXT_KEY_VERSION,
  sealConnectorSecret,
} from '../repository/connector-shared.js';

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
  dropLegacyKnowledgeEntriesTable(db);
  const statements = splitSqlStatements(loadSchemaSql());
  for (const stmt of statements) {
    db.run(sql.raw(stmt));
  }
  // Additive migrations after CREATE TABLE IF NOT EXISTS — these handle
  // columns added to existing tables on already-built databases. Each
  // step is idempotent and inspects sqlite_master / pragma first.
  addProvenanceColumnIfMissing(db);
  addAlertInvestigationStateColumnsIfMissing(db);
  addRemediationVerificationColumnsIfMissing(db);
  dropLegacyConnectorTeamPoliciesTable(db);
  encryptLegacyConnectorSecrets(db);
}

/**
 * Re-encrypt `connector_secrets` rows written before connector credentials
 * were encrypted at rest. Those rows carry `key_version = 1` and hold the raw
 * kubeconfig / token bytes; this wraps each in an AES-256-GCM envelope and
 * bumps `key_version`. Idempotent — a second boot finds no version-1 rows.
 *
 * SECRET_KEY is only resolved when there is something to convert, so fresh
 * databases (and tests) never require it.
 */
function encryptLegacyConnectorSecrets(db: SqliteClient): void {
  const rows = db.all<{ connector_id: string; ciphertext: Uint8Array }>(sql`
    SELECT connector_id, ciphertext FROM connector_secrets
    WHERE key_version = ${CONNECTOR_SECRET_PLAINTEXT_KEY_VERSION}
  `);
  for (const row of rows) {
    db.run(sql`
      UPDATE connector_secrets
      SET ciphertext = ${sealConnectorSecret(row.ciphertext)},
          key_version = ${CONNECTOR_SECRET_KEY_VERSION}
      WHERE connector_id = ${row.connector_id}
    `);
  }
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
 * Drop the obsolete `connector_team_policies` table if it still exists from
 * a pre-refactor database. The new `connector_policies` table is created
 * fresh by `applySchema`; any legacy rows are intentionally discarded
 * (no data migration — admins re-author policies in the new UI).
 */
function dropLegacyConnectorTeamPoliciesTable(db: SqliteClient): void {
  db.run(sql.raw('DROP TABLE IF EXISTS connector_team_policies'));
}

/**
 * Drop the legacy `knowledge_entries` table if it still carries the old
 * `kind` column. The skill-style refactor removed `kind` + `content` and
 * added `description` + `body`; ALTER incrementally is more code than a
 * clean drop. Only legacy rows are discarded — bundled seeds re-load on
 * boot via the gateway loader.
 */
function dropLegacyKnowledgeEntriesTable(db: SqliteClient): void {
  const cols = db.all<{ name: string }>(
    sql.raw("PRAGMA table_info('knowledge_entries')"),
  );
  if (cols.length === 0) return;
  const names = new Set(cols.map((c) => c.name));
  if (names.has('description')) return;
  if (names.has('kind')) {
    db.run(sql.raw('DROP TABLE IF EXISTS knowledge_entries'));
  }
}

function addProvenanceColumnIfMissing(db: SqliteClient): void {
  const cols = db.all<{ name: string }>(
    sql`PRAGMA table_info('investigation_reports')`,
  );
  if (!cols.some((c) => c.name === 'provenance')) {
    db.run(sql.raw('ALTER TABLE investigation_reports ADD COLUMN provenance TEXT'));
  }
}

function addAlertInvestigationStateColumnsIfMissing(db: SqliteClient): void {
  const cols = db.all<{ name: string }>(
    sql`PRAGMA table_info('alert_rules')`,
  );
  if (cols.length === 0) return;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('investigation_started_at')) {
    db.run(sql.raw('ALTER TABLE alert_rules ADD COLUMN investigation_started_at TEXT'));
  }
  if (!names.has('investigation_failed_at')) {
    db.run(sql.raw('ALTER TABLE alert_rules ADD COLUMN investigation_failed_at TEXT'));
  }
  if (!names.has('investigation_failure_reason')) {
    db.run(sql.raw('ALTER TABLE alert_rules ADD COLUMN investigation_failure_reason TEXT'));
  }
}

function addRemediationVerificationColumnsIfMissing(db: SqliteClient): void {
  const cols = db.all<{ name: string }>(
    sql`PRAGMA table_info('remediation_plan')`,
  );
  if (cols.length === 0) return;
  const names = new Set(cols.map((c) => c.name));
  const additions: Array<[string, string]> = [
    ['linked_alert_rule_id', 'ALTER TABLE remediation_plan ADD COLUMN linked_alert_rule_id TEXT'],
    ['target_object', 'ALTER TABLE remediation_plan ADD COLUMN target_object TEXT'],
    ['validation_method', 'ALTER TABLE remediation_plan ADD COLUMN validation_method TEXT'],
    ['verification_status', "ALTER TABLE remediation_plan ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'not_started'"],
    ['verification_started_at', 'ALTER TABLE remediation_plan ADD COLUMN verification_started_at TEXT'],
    ['verification_deadline_at', 'ALTER TABLE remediation_plan ADD COLUMN verification_deadline_at TEXT'],
    ['verification_evidence_json', 'ALTER TABLE remediation_plan ADD COLUMN verification_evidence_json TEXT'],
    ['continuation_investigation_id', 'ALTER TABLE remediation_plan ADD COLUMN continuation_investigation_id TEXT'],
  ];
  for (const [name, statement] of additions) {
    if (!names.has(name)) db.run(sql.raw(statement));
  }
  db.run(sql.raw(
    'CREATE INDEX IF NOT EXISTS ix_remediation_plan_verification ON remediation_plan(verification_status, verification_deadline_at)',
  ));
}
