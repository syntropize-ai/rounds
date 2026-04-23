/**
 * Postgres migration runner for the W2 instance-config tables.
 *
 * Scope-limited on purpose: this applies ONLY the migrations under
 * `postgres/migrations/*.sql` (currently just `001_instance_settings.sql`).
 * The W6 stores (dashboards, investigations, alert rules) remain SQLite-only
 * this sprint; if a future migration here depends on the W6 tables, that
 * dependency needs to be declared explicitly.
 *
 * Tracking table: `_postgres_instance_migrations` keyed on filename. Each
 * migration runs in its own transaction (BEGIN / COMMIT / ROLLBACK) so a
 * partial failure leaves the database untouched.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { splitSqlStatements } from '../../db/migrate.js';

interface SqlMigration {
  name: string;
  sql: string;
}

function loadPostgresMigrations(): SqlMigration[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    // Fallback for environments where `.sql` files weren't copied into dist.
    join(here, '..', '..', '..', 'src', 'repository', 'postgres', 'migrations'),
  ];
  let dir: string | undefined;
  for (const c of candidates) {
    if (existsSync(c) && readdirSync(c).some((f) => f.endsWith('.sql'))) {
      dir = c;
      break;
    }
  }
  if (!dir) {
    throw new Error(
      `[data-layer] could not locate postgres migrations directory. Tried: ${candidates.join(', ')}`,
    );
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(dir!, name), 'utf8'),
  }));
}

/**
 * Apply any pending Postgres instance-config migrations. Idempotent — already
 * applied migrations (by filename) are skipped. Each migration runs in its
 * own transaction.
 */
export async function applyPostgresInstanceMigrations(
  db: DbClient,
): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _postgres_instance_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    )
  `);

  const appliedResult = await db.execute(
    sql`SELECT name FROM _postgres_instance_migrations`,
  );
  const applied = new Set(
    (appliedResult.rows as unknown as Array<{ name: string }>).map((r) => r.name),
  );

  const pending = loadPostgresMigrations().filter((m) => !applied.has(m.name));

  // drizzle's `db.transaction(fn)` checks out a single connection from the
  // pool and wires `BEGIN / COMMIT / ROLLBACK` around `fn`. Using raw BEGIN
  // / COMMIT via `db.execute` would land on random pool connections and the
  // transaction boundaries would be lost.
  for (const mig of pending) {
    try {
      await db.transaction(async (tx) => {
        const statements = splitSqlStatements(mig.sql);
        for (const stmt of statements) {
          await tx.execute(sql.raw(stmt));
        }
        await tx.execute(
          sql`INSERT INTO _postgres_instance_migrations (name) VALUES (${mig.name})`,
        );
      });
    } catch (err) {
      throw new Error(
        `[data-layer] postgres migration ${mig.name} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
