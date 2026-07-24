import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { splitSqlStatements } from '../../db/schema-applier.js';

/**
 * Locate `schema.sql` next to this module. In dev (tsx, src tree) the file
 * sits alongside the .ts source; in built dist the .sql isn't copied by tsc,
 * so we fall back to the sibling src tree.
 */
function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'schema.sql'),
    join(here, '..', '..', '..', 'src', 'repository', 'postgres', 'schema.sql'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8');
  }
  throw new Error(
    `[data-layer] could not locate postgres schema.sql. Tried: ${candidates.join(', ')}`,
  );
}

/**
 * Create every Postgres table and index in `schema.sql`. Idempotent — every
 * statement uses `IF NOT EXISTS`. Wrapped in a single transaction so a partial
 * failure leaves the database untouched.
 */
export async function applyPostgresSchema(db: DbClient): Promise<void> {
  const statements = splitSqlStatements(loadSchemaSql());
  await db.transaction(async (tx) => {
    // One-shot rename for instances created before the `user` -> `users`
    // rename. Runs inside the same tx as the CREATE TABLE IF NOT EXISTS so
    // either both happen or neither does.
    await renameLegacyUserTable(tx);
    await dropLegacyKnowledgeEntriesTable(tx);
    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt));
    }
    // One-shot column-type fix for instances created when these columns were
    // INTEGER NOT NULL DEFAULT 0. Drizzle declares them as boolean; the SQL
    // type drift broke reads. The CREATE TABLE IF NOT EXISTS above does not
    // alter existing columns, so retrofit type-by-type.
    await fixLegacyBooleanColumns(tx);
    await addRemediationVerificationColumns(tx);
  });
}

async function fixLegacyBooleanColumns(tx: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  // (table, column) pairs whose Drizzle type is boolean but legacy SQL was INTEGER.
  const targets: Array<[string, string]> = [
    ['incidents', 'archived'],
    ['feed_items', 'followed_up'],
  ];
  for (const [table, column] of targets) {
    await tx.execute(sql.raw(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name = '${column}'
            AND data_type = 'integer'
        ) THEN
          EXECUTE 'ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT';
          EXECUTE 'ALTER TABLE ${table} ALTER COLUMN ${column} TYPE BOOLEAN USING (${column} <> 0)';
          EXECUTE 'ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT FALSE';
        END IF;
      END
      $$;
    `));
  }
}

async function dropLegacyKnowledgeEntriesTable(tx: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  // Skill-style refactor: legacy `knowledge_entries` had `kind` + `content`
  // columns that no longer exist. Drop the whole table if those legacy cols
  // are still present (no migration of rows — bundled seeds re-load on boot).
  await tx.execute(sql.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'knowledge_entries' AND column_name = 'kind'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'knowledge_entries' AND column_name = 'description'
      ) THEN
        EXECUTE 'DROP TABLE IF EXISTS knowledge_entries';
      END IF;
    END
    $$;
  `));
}

async function addRemediationVerificationColumns(tx: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  await tx.execute(sql.raw(`
    ALTER TABLE remediation_plan
      ADD COLUMN IF NOT EXISTS linked_alert_rule_id TEXT,
      ADD COLUMN IF NOT EXISTS target_object TEXT,
      ADD COLUMN IF NOT EXISTS validation_method TEXT,
      ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS verification_started_at TEXT,
      ADD COLUMN IF NOT EXISTS verification_deadline_at TEXT,
      ADD COLUMN IF NOT EXISTS verification_evidence_json JSONB,
      ADD COLUMN IF NOT EXISTS continuation_investigation_id TEXT;
  `));
  await tx.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS ix_remediation_plan_verification
      ON remediation_plan(verification_status, verification_deadline_at);
  `));
}

async function renameLegacyUserTable(tx: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  // pg_tables is only populated for the current search_path; both legacy
  // `user` and the new `users` are created in the default schema, so this is
  // sufficient.
  await tx.execute(sql.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'user')
         AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'users') THEN
        EXECUTE 'ALTER TABLE "user" RENAME TO users';
      END IF;
    END
    $$;
  `));
}
