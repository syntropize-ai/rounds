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
    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt));
    }
  });
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
