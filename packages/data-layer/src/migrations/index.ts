import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A name-addressed SQL migration loaded from disk.
 *
 * Name is the filename without extension (e.g. `001_org.sql`). Ordering is
 * alphabetical-by-name, which matches numeric ordering given the `NNN_` prefix.
 */
export interface SqlMigration {
  name: string;
  sql: string;
}

/**
 * Load all `*.sql` files from `packages/data-layer/src/migrations/`.
 *
 * We resolve the directory relative to this module's URL so that:
 *  - at dev/tsx runtime the `src/migrations` directory is read directly,
 *  - at built runtime, after `tsc --build` copies `.sql` files into `dist/migrations`,
 *    the same lookup works.
 *
 * If the colocated directory doesn't contain `.sql` files (e.g. someone ran
 * `tsc` without the copy step), we fall back to the sibling `src/migrations`
 * dir two levels up from `dist/migrations/index.js`, so operator error becomes
 * visible rather than silent no-op.
 */
export function loadSqlMigrations(): SqlMigration[] {
  const here = dirname(fileURLToPath(import.meta.url));

  // Candidate lookup order — first hit wins.
  const candidates = [
    here,
    // When dist/migrations/index.js exists but .sql files weren't copied,
    // fall back to the sibling src tree if present.
    join(here, '..', '..', 'src', 'migrations'),
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
      `[data-layer] could not locate migrations directory. Tried: ${candidates.join(', ')}`,
    );
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // alphabetical == numeric because of NNN_ prefix

  return files.map((name) => ({
    name,
    sql: readFileSync(join(dir!, name), 'utf8'),
  }));
}
