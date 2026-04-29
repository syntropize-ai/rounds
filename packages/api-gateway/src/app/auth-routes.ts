/**
 * Auth subsystem + auth-route wiring extracted from
 * `server.ts::createApp()`.
 *
 * Two phases so the caller can build a SetupConfigService with the
 * resolved AuditWriter between them:
 *
 *   1. `buildAuthSubsystem(db, repos, quotas)` → uses the selected backend
 *      repos plus the quota repository; runs the idempotent auth-to-db
 *      migration / seed-admin fallback, builds the
 *      AuthSubsystem + ApiKeyService + authMw, and registers `authMw` as
 *      the module-level singleton (kills the old 503-shim race window).
 *
 *   2. `mountAuthRoutes(app, deps)`       → mounts /api/setup, /api/user,
 *      /api/, /api/admin once the SetupConfigService and rate limiter are
 *      ready.
 */

import type { Application, RequestHandler } from 'express';
import { createLogger } from '@agentic-obs/common/logging';
import type { IQuotaRepository } from '@agentic-obs/common';
import { createAuthSubsystem } from '../auth/auth-manager.js';
import type { AuthSubsystem } from '../auth/auth-manager.js';
import { migrateAuthToDbIfNeeded } from '../migrations/auth-to-db.js';
import { seedAdminIfNeeded } from '../auth/seed-admin.js';
import { seedAutoInvestigationSaIfNeeded } from '../auth/seed-auto-investigation-sa.js';
import { createAuthRouter } from '../routes/auth.js';
import { createUserRouter } from '../routes/user.js';
import { createAdminRouter } from '../routes/admin.js';
import { createSetupRouter } from '../routes/setup.js';
import {
  authMiddleware,
  createAuthMiddleware,
  setAuthMiddleware,
} from '../middleware/auth.js';
import { createOrgContextMiddleware } from '../middleware/org-context.js';
import { ApiKeyService } from '../services/apikey-service.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuthRepositoryBundle } from './persistence.js';
import type { QueryClient } from '@agentic-obs/data-layer';

const log = createLogger('auth-routes');

export type AuthRepositories = AuthRepositoryBundle;

export interface AuthSubsystemBundle {
  authRepos: AuthRepositories;
  authSub: AuthSubsystem;
  apiKeyService: ApiKeyService;
  authMw: RequestHandler;
}

/**
 * Idempotent auth-to-db migration with a direct seed-admin fallback.
 * Awaiting this from createApp removes the historical race where a
 * fresh DB could serve auth requests before the seed admin existed.
 */
async function runAuthMigration(
  db: QueryClient,
  authRepos: AuthRepositories,
): Promise<void> {
  try {
    await migrateAuthToDbIfNeeded({
      db,
      users: authRepos.users,
      orgs: authRepos.orgs,
      orgUsers: authRepos.orgUsers,
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'auth migration failed; falling back to direct seed',
    );
    try {
      await seedAdminIfNeeded(authRepos);
    } catch (err2) {
      log.error(
        { err: err2 instanceof Error ? err2.message : err2 },
        'seed admin fallback failed',
      );
    }
  }

  // Idempotently seed the auto-investigation SA. Runs after the admin
  // bootstrap above so the org exists. Failures here are non-fatal — the
  // SA only matters for the alert.fired auto-trigger, and that path is
  // separately gated by AUTO_INVESTIGATION_SA_TOKEN at boot.
  try {
    await seedAutoInvestigationSaIfNeeded({
      users: authRepos.users,
      orgUsers: authRepos.orgUsers,
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'auto-investigation SA seed failed; alert auto-investigations will be unavailable until fixed',
    );
  }
}

/**
 * Phase 1 — build the auth subsystem and bind the global authMiddleware
 * singleton. After this resolves, all route files that import
 * `authMiddleware` will see the real implementation; the 503 shim path
 * in `middleware/auth.ts` is no longer reachable from `createApp`.
 */
export async function buildAuthSubsystem(
  db: QueryClient,
  authRepos: AuthRepositories,
  quotas: IQuotaRepository,
): Promise<AuthSubsystemBundle> {
  await runAuthMigration(db, authRepos);

  const authSub = await createAuthSubsystem(authRepos);

  const apiKeyService = new ApiKeyService({
    apiKeys: authRepos.apiKeys,
    users: authRepos.users,
    orgUsers: authRepos.orgUsers,
    quotas,
    audit: authSub.audit,
  });

  const authMw = createAuthMiddleware({
    sessions: authSub.sessions,
    users: authRepos.users,
    orgUsers: authRepos.orgUsers,
    apiKeys: authRepos.apiKeys,
    apiKeyService,
  });
  setAuthMiddleware(authMw);

  return { authRepos, authSub, apiKeyService, authMw };
}

export interface MountAuthRoutesDeps {
  app: Application;
  db: QueryClient;
  quotas: IQuotaRepository;
  bundle: AuthSubsystemBundle;
  setupConfig: SetupConfigService;
  ac: AccessControlSurface;
  userRateLimiter: RequestHandler;
  defaultOrgId?: string;
}

/**
 * Phase 2 — mount the setup wizard, /api/user, /api/ (login + oauth +
 * SAML ACS), and /api/admin. Requires the resolved auth subsystem and
 * the SetupConfigService (built once `authSub.audit` is available so
 * config-mutation events get audited).
 */
export function mountAuthRoutes(deps: MountAuthRoutesDeps): void {
  const { app, bundle, setupConfig, ac, userRateLimiter } = deps;
  const { authRepos, authSub, authMw } = bundle;
  const defaultOrgId = deps.defaultOrgId ?? 'org_main';

  app.use(
    '/api/setup',
    createSetupRouter({
      setupConfig,
      users: authRepos.users,
      orgs: authRepos.orgs,
      orgUsers: authRepos.orgUsers,
      sessions: authSub.sessions,
      audit: authSub.audit,
      defaultOrgId,
      authMiddleware,
      ac,
    }),
  );

  app.use(
    '/api/user',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createUserRouter({
      users: authRepos.users,
      userAuth: authRepos.userAuth,
      orgUsers: authRepos.orgUsers,
      preferences: authRepos.preferences,
      sessions: authSub.sessions,
      audit: authSub.audit,
    }),
  );

  app.use(
    '/api',
    createAuthRouter({
      users: authRepos.users,
      userAuth: authRepos.userAuth,
      orgUsers: authRepos.orgUsers,
      sessions: authSub.sessions,
      local: authSub.local,
      github: authSub.github,
      google: authSub.google,
      generic: authSub.generic,
      ldap: authSub.ldap,
      saml: authSub.saml,
      audit: authSub.audit,
      defaultOrgId,
    }),
  );

  app.use(
    '/api/admin',
    authMw,
    userRateLimiter,
    createAdminRouter({
      users: authRepos.users,
      orgUsers: authRepos.orgUsers,
      userAuthTokens: authRepos.userAuthTokens,
      auditLog: authRepos.auditLog,
      sessions: authSub.sessions,
      audit: authSub.audit,
      quotas: deps.quotas,
      defaultOrgId,
    }),
  );
}
