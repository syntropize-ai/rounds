/**
 * First-run admin bootstrap.
 *
 * Reads SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_LOGIN / SEED_ADMIN_NAME
 * and creates a server-admin user if the `user` table is empty. Re-runs are
 * no-ops once any user exists (including one created via the setup wizard).
 *
 * See docs/auth-perm-design/10-migration-plan.md and T9.1 for the final
 * migration story; this function is the minimum required by T2.1.
 */

import type {
  IOrgRepository,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import { hashPassword, passwordMinLength } from './local-provider.js';

const log = createLogger('seed-admin');

export interface SeedAdminDeps {
  users: IUserRepository;
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
}

export interface SeedAdminOptions {
  email?: string;
  login?: string;
  name?: string;
  password?: string;
  orgId?: string;
}

/**
 * Seed admin if (a) no user rows exist AND (b) SEED_ADMIN_* env vars are set.
 * Returns the created user id, or null on no-op.
 */
export async function seedAdminIfNeeded(
  deps: SeedAdminDeps,
  opts: SeedAdminOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  // Exclude service accounts. Without this filter, seed-auto-
  // investigation-sa (which runs at every boot) creates the openobs SA
  // first, this check sees total > 0 and bails — meaning a fresh
  // install with SEED_ADMIN_EMAIL/PASSWORD set would never seed the
  // human admin. Boot order is: migrations → seed-admin → seed SA.
  const list = await deps.users.list({ limit: 1, isServiceAccount: false });
  if (list.total > 0) {
    return null;
  }

  const email = opts.email ?? env['SEED_ADMIN_EMAIL'];
  const password = opts.password ?? env['SEED_ADMIN_PASSWORD'];
  const login = opts.login ?? env['SEED_ADMIN_LOGIN'] ?? 'admin';
  const name = opts.name ?? env['SEED_ADMIN_NAME'] ?? 'Server Admin';
  const orgId = opts.orgId ?? 'org_main';

  if (!email || !password) {
    log.info('no users yet; SEED_ADMIN_EMAIL/PASSWORD not set, skipping seed');
    return null;
  }
  const minLen = passwordMinLength(env);
  if (password.length < minLen) {
    log.warn(
      { minLen },
      `SEED_ADMIN_PASSWORD must be at least ${minLen} chars; seed skipped`,
    );
    return null;
  }

  // Ensure the default org exists (migration 001 inserts it, but we tolerate
  // a missing row for resilience — e.g. test DB that bypassed migrations).
  const existingOrg = await deps.orgs.findById(orgId);
  if (!existingOrg) {
    await deps.orgs.create({ id: orgId, name: 'Main Org' });
  }

  const hash = await hashPassword(password);
  const user = await deps.users.create({
    email,
    name,
    login,
    password: hash,
    orgId,
    isAdmin: true,
    emailVerified: true,
  });
  await deps.orgUsers.create({
    orgId,
    userId: user.id,
    role: 'Admin',
  });
  log.info({ userId: user.id, login }, 'seed admin created');
  return user.id;
}
