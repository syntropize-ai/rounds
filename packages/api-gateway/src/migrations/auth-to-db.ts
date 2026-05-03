/**
 * T9.1 — Auth data migration (env-seed admin → DB).
 *
 * Idempotent bootstrap step run once on gateway startup, after the name-based
 * schema migrations have been applied. It does exactly one of:
 *
 *   (a) already-migrated: `_runtime_settings.auth_migrated_v1 = 'true'` → no-op.
 *   (b) existing users: users.total > 0 → set marker, no-op.
 *   (c) env-seeded admin: SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD set →
 *       delegates to the existing `seedAdminIfNeeded` helper (which is itself
 *       idempotent — it re-checks the user count).
 *   (d) fresh install with no env seed: logs a warning telling the operator
 *       to complete the setup wizard, and sets the marker so we don't repeat
 *       the warning on every boot.
 *
 * Dry-run mode: `OPENOBS_AUTH_MIGRATE_DRY_RUN=true` prints the plan without
 * writing to the DB.
 *
 * Rationale: the T9 design doc lists full workspace→org data migration, but
 * workspaces were never populated in live installs (they were a stub).
 * Walking a zero-row table is a no-op; we keep the hook here so future
 * migrations have a landing pad.
 */

import { sql } from 'drizzle-orm';
import type { QueryClient } from '@agentic-obs/data-layer';
import type {
  IOrgRepository,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import { seedAdminIfNeeded } from '../auth/seed-admin.js';

const log = createLogger('auth-migrate');

const MARKER_KEY = 'auth_migrated_v1';

export interface AuthMigrationDeps {
  db: QueryClient;
  users: IUserRepository;
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
  env?: NodeJS.ProcessEnv;
}

export interface AuthMigrationResult {
  ran: boolean;
  skipped: boolean;
  reason: 'already_migrated' | 'users_exist' | 'env_seed' | 'no_op_fresh_install';
  dryRun: boolean;
  createdUserId: string | null;
}

function isDryRun(env: NodeJS.ProcessEnv): boolean {
  return env['OPENOBS_AUTH_MIGRATE_DRY_RUN'] === 'true'
    || env['OPENOBS_AUTH_MIGRATE_DRY_RUN'] === '1';
}

async function readMarker(db: QueryClient): Promise<boolean> {
  try {
    const rows = await db.all<{ value: string }>(
      sql`SELECT value FROM _runtime_settings WHERE id = ${MARKER_KEY} LIMIT 1`,
    );
    return rows[0]?.value === 'true';
  } catch {
    // Table may not exist yet if migration 018 hasn't been applied. Treat as
    // not-migrated so the caller re-runs migrations, then retry.
    return false;
  }
}

async function writeMarker(db: QueryClient): Promise<void> {
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO _runtime_settings (id, value, updated) VALUES (${MARKER_KEY}, 'true', ${now})
    ON CONFLICT(id) DO UPDATE SET value = 'true', updated = ${now}
  `);
}

/**
 * Run the migration. Returns a result describing what happened; safe to call
 * on every boot — the marker makes repeat invocations no-ops.
 */
export async function migrateAuthToDbIfNeeded(
  deps: AuthMigrationDeps,
): Promise<AuthMigrationResult> {
  const env = deps.env ?? process.env;
  const dryRun = isDryRun(env);

  if (await readMarker(deps.db)) {
    log.debug('auth migration marker set; skipping');
    return {
      ran: false,
      skipped: true,
      reason: 'already_migrated',
      dryRun,
      createdUserId: null,
    };
  }

  // Exclude service accounts so the auto-investigation SA (seeded at
  // every boot) never makes a fresh install look "already migrated".
  const existing = await deps.users.list({ limit: 1, isServiceAccount: false });
  if (existing.total > 0) {
    log.info({ userCount: existing.total }, 'users already present; marking migration done');
    if (!dryRun) await writeMarker(deps.db);
    return {
      ran: false,
      skipped: true,
      reason: 'users_exist',
      dryRun,
      createdUserId: null,
    };
  }

  const seedEmail = env['SEED_ADMIN_EMAIL'];
  const seedPass = env['SEED_ADMIN_PASSWORD'];
  if (seedEmail && seedPass) {
    if (dryRun) {
      log.info(
        { seedEmail },
        '[dry-run] would seed admin user from SEED_ADMIN_* env vars',
      );
      return {
        ran: false,
        skipped: true,
        reason: 'env_seed',
        dryRun,
        createdUserId: null,
      };
    }
    const createdUserId = await seedAdminIfNeeded(
      { users: deps.users, orgs: deps.orgs, orgUsers: deps.orgUsers },
      {},
      env,
    );
    await writeMarker(deps.db);
    log.info({ createdUserId }, 'auth migration seeded env admin');
    return {
      ran: true,
      skipped: false,
      reason: 'env_seed',
      dryRun,
      createdUserId,
    };
  }

  // No users, no env seed → fresh install. Leave for the setup wizard.
  log.warn(
    'Empty auth state and no SEED_ADMIN_* configured. Run the setup wizard to create the first admin.',
  );
  if (!dryRun) await writeMarker(deps.db);
  return {
    ran: false,
    skipped: true,
    reason: 'no_op_fresh_install',
    dryRun,
    createdUserId: null,
  };
}
