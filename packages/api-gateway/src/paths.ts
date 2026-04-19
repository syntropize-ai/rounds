/**
 * Single source of truth for persistent-state paths.
 *
 * Before this module, five files resolved the data directory independently:
 *   main.ts              → ./.agentic-obs
 *   server.ts            → ./.uname-data  (legacy typo)
 *   persistence.ts       → ./.uname-data  (legacy typo)
 *   routes/setup.ts      → ~/.agentic-obs/config.json  (HOME, not DATA_DIR)
 *   auth/bootstrap-secrets.ts (took arg)
 *
 * Result: secrets went to one dir, SQLite to another, LLM config to a
 * third, and wiping one didn't wipe the others. This module fixes it:
 * every path in the gateway flows through one of the exported helpers.
 *
 * Directory layout after consolidation:
 *   <DATA_DIR>/
 *     openobs.db          ← SQLite: users, orgs, dashboards, all business state
 *     openobs.db-wal / -shm
 *     secrets.json        ← JWT_SECRET + SECRET_KEY (0600, auto-generated)
 *     stores.json         ← legacy in-memory-mode snapshot (only when DATABASE_URL absent AND SQLite disabled)
 *
 * Resolution order:
 *   1. process.env.DATA_DIR (explicit operator override)
 *   2. <cwd>/.openobs       (our canonical name going forward)
 *
 * The legacy names (.uname-data, .agentic-obs) are tried as fallbacks if
 * they already exist on disk, for zero-friction migration from old installs.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY_NAMES = ['.agentic-obs', '.uname-data'];
const CANONICAL_NAME = '.openobs';

let cached: string | undefined;

/** Absolute path of the persistent state directory. Memoized. */
export function dataDir(): string {
  if (cached) return cached;
  const override = process.env['DATA_DIR'];
  if (override) {
    cached = override;
    return cached;
  }
  // If a legacy dir is already populated in cwd, keep using it so users
  // upgrading in place don't lose state. Otherwise use the canonical name.
  for (const name of LEGACY_NAMES) {
    const candidate = join(process.cwd(), name);
    if (existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  }
  cached = join(process.cwd(), CANONICAL_NAME);
  return cached;
}

export function dbPath(): string {
  return process.env['SQLITE_PATH'] ?? join(dataDir(), 'openobs.db');
}

export function secretsPath(): string {
  return join(dataDir(), 'secrets.json');
}

export function legacyStoresPath(): string {
  return join(dataDir(), 'stores.json');
}

// Note: `legacyHomeConfigPath()` (~/.agentic-obs/config.json) was removed in
// W2 / T2.4. No instance of openobs that this codebase shipped was using it,
// so there's nothing to migrate — the repositories in
// packages/data-layer/src/repository/sqlite are the only source of truth now.
