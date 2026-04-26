/**
 * RBAC + org/team/service-account/folder route wiring extracted from
 * `server.ts::createApp()`.
 *
 * Builds the AccessControlService (W2/T3), seeds the role catalog into
 * `org_main`, and mounts:
 *   - `/api/user/permissions`              — caller's resolved perms
 *   - `/api/access-control/*`              — role CRUD + assignments
 *   - `/api/orgs`, `/api/org`              — org CRUD + membership
 *   - `/api/teams`                         — team CRUD + memberships
 *   - `/api/serviceaccounts`               — SAs + their tokens
 *   - `/api/user` (tokens), `/api/auth/keys`
 *   - `/api/folders`                       — Grafana-parity folder API
 *   - `/api/dashboards`, `/api/datasources`, `/api/access-control/alert.rules`
 *     resource-permission management routers (mounted BEFORE the W6
 *     domain mounts in `domain-routes.ts` so their handlers shadow the
 *     legacy in-memory permission routes).
 *
 * Returns the AccessControlService and shared folder repo so the domain
 * mounts can reuse them. The dashboard / alert-rule folder-uid resolvers
 * call repo methods (`DashboardRepository.getFolderUid`,
 * `AlertRuleRepository.getFolderUid`) instead of running raw SQL inline.
 */

import type { Application, RequestHandler } from 'express';
import {
  DashboardAclRepository,
  FolderRepository,
  PermissionRepository,
  RoleRepository,
  TeamRepository,
  TeamMemberRepository,
  TeamRoleRepository,
  UserRoleRepository,
  QuotaRepository,
  seedRbacForOrg,
} from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/common/logging';
import { AccessControlService } from '../services/accesscontrol-service.js';
import { AccessControlHolder } from '../services/accesscontrol-holder.js';
import { DashboardAclService } from '../services/dashboard-acl-service.js';
import { FolderService } from '../services/folder-service.js';
import { OrgService } from '../services/org-service.js';
import { ResourcePermissionService } from '../services/resource-permission-service.js';
import { ServiceAccountService } from '../services/serviceaccount-service.js';
import { TeamService } from '../services/team-service.js';
import type { ApiKeyService } from '../services/apikey-service.js';
import type { AuthSubsystem } from '../auth/auth-manager.js';
import { createResolverRegistry } from '../rbac/resolvers/index.js';
import { createAccessControlRouter } from '../routes/access-control.js';
import { createUserPermissionsRouter } from '../routes/user-permissions.js';
import { createOrgsRouter } from '../routes/orgs.js';
import { createOrgRouter } from '../routes/org.js';
import { createTeamsRouter } from '../routes/teams.js';
import { createServiceAccountsRouter } from '../routes/serviceaccounts.js';
import { createUserTokensRouter } from '../routes/user-tokens.js';
import { createAuthKeysRouter } from '../routes/auth-keys.js';
import { createFolderRouter } from '../routes/folders.js';
import { createDashboardPermissionsRouter } from '../routes/dashboard-permissions.js';
import { createDatasourcePermissionsRouter } from '../routes/datasource-permissions.js';
import { createAlertRulePermissionsRouter } from '../routes/alert-rule-permissions.js';
import { createOrgContextMiddleware } from '../middleware/org-context.js';
import type { AuthRepositories } from './auth-routes.js';
import type { Persistence } from './persistence.js';

const log = createLogger('rbac-routes');

export interface MountRbacRoutesDeps {
  app: Application;
  persistence: Persistence;
  authRepos: AuthRepositories;
  authSub: AuthSubsystem;
  authMw: RequestHandler;
  apiKeyService: ApiKeyService;
  userRateLimiter: RequestHandler;
  /**
   * Pre-built holder created in createApp() so route factories that need
   * the AccessControlSurface synchronously (the common-routes block) can
   * receive it before this function resolves. We `.set()` the real
   * service onto it here.
   */
  accessControlHolder: AccessControlHolder;
  defaultOrgId?: string;
}

export interface MountRbacRoutesResult {
  accessControl: AccessControlService;
  /** Shared by chat/dashboard agent tooling so folder.* resolves to the
   * same table the UI uses. */
  sharedFolderRepo: FolderRepository;
}

export async function mountRbacRoutes(
  deps: MountRbacRoutesDeps,
): Promise<MountRbacRoutesResult> {
  const {
    app,
    persistence,
    authRepos,
    authSub,
    authMw,
    apiKeyService,
    userRateLimiter,
    accessControlHolder,
  } = deps;
  const defaultOrgId = deps.defaultOrgId ?? 'org_main';
  const { sqliteDb, repos } = persistence;

  // Construct RBAC repositories.
  const rbacRoleRepo = new RoleRepository(sqliteDb);
  const rbacPermissionRepo = new PermissionRepository(sqliteDb);
  const rbacUserRoles = new UserRoleRepository(sqliteDb);
  const rbacTeamRoles = new TeamRoleRepository(sqliteDb);
  const rbacTeamMembers = new TeamMemberRepository(sqliteDb);
  const sharedFolderRepo = new FolderRepository(sqliteDb);

  try {
    await seedRbacForOrg(sqliteDb, defaultOrgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'seed rbac failed',
    );
  }

  // Legacy dashboard_acl read-only fallback for RBAC evaluation (T7.6).
  const legacyAclService = new DashboardAclService({
    dashboardAcl: new DashboardAclRepository(sqliteDb),
    folders: sharedFolderRepo,
    teamMembers: rbacTeamMembers,
    db: sqliteDb,
  });

  const accessControl = new AccessControlService({
    permissions: rbacPermissionRepo,
    roles: rbacRoleRepo,
    userRoles: rbacUserRoles,
    teamRoles: rbacTeamRoles,
    teamMembers: rbacTeamMembers,
    orgUsers: authRepos.orgUsers,
    legacyAcl: legacyAclService,
    resolvers: (orgId) =>
      createResolverRegistry({
        folders: sharedFolderRepo,
        orgId,
        // Dashboard / alert-rule folder-uid lookups now go through
        // dedicated repo methods; the inline raw-SQL block in createApp
        // is gone with this commit.
        dashboardFolderUid: (oid, dashUid) =>
          Promise.resolve(repos.dashboards.getFolderUid(oid, dashUid)),
        alertRuleFolderUid: (oid, ruleUid) =>
          Promise.resolve(repos.alertRules.getFolderUid(oid, ruleUid)),
      }),
  });

  // Bind the holder so domain routers built before this function ran
  // start consulting the real service.
  accessControlHolder.set(accessControl);

  app.use(
    '/api/user',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createUserPermissionsRouter(accessControl),
  );

  app.use(
    '/api/access-control',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createAccessControlRouter({
      ac: accessControl,
      roleRepo: rbacRoleRepo,
      permissionRepo: rbacPermissionRepo,
      userRoles: rbacUserRoles,
      teamRoles: rbacTeamRoles,
      db: sqliteDb,
    }),
  );

  // -- Orgs / org membership (W3 / T4.1) ---------------------------------
  const quotasRepo = new QuotaRepository(sqliteDb);
  const orgService = new OrgService({
    orgs: authRepos.orgs,
    orgUsers: authRepos.orgUsers,
    users: authRepos.users,
    quotas: quotasRepo,
    audit: authSub.audit,
    db: sqliteDb,
    defaultOrgId,
  });

  app.use(
    '/api/orgs',
    authMw,
    userRateLimiter,
    // No orgContext middleware — server-admin flows here (list-all,
    // create new org) don't require a current org.
    createOrgsRouter({ orgs: orgService, ac: accessControl }),
  );

  app.use(
    '/api/org',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createOrgRouter({
      orgs: orgService,
      ac: accessControl,
      preferences: authRepos.preferences,
    }),
  );

  // -- Teams (W4 / T5.1) -------------------------------------------------
  const teamRepo = new TeamRepository(sqliteDb);
  const teamService = new TeamService({
    teams: teamRepo,
    teamMembers: rbacTeamMembers,
    preferences: authRepos.preferences,
    db: sqliteDb,
    audit: authSub.audit,
  });
  app.use(
    '/api/teams',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createTeamsRouter({ teams: teamService, ac: accessControl }),
  );

  // -- Service accounts + tokens (W4 / T6) -------------------------------
  const saService = new ServiceAccountService({
    users: authRepos.users,
    orgUsers: authRepos.orgUsers,
    apiKeys: authRepos.apiKeys,
    userRoles: rbacUserRoles,
    teamMembers: rbacTeamMembers,
    quotas: quotasRepo,
    audit: authSub.audit,
  });
  app.use(
    '/api/serviceaccounts',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createServiceAccountsRouter({
      serviceAccounts: saService,
      apiKeys: apiKeyService,
      ac: accessControl,
    }),
  );
  app.use(
    '/api/user',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createUserTokensRouter({ apiKeys: apiKeyService }),
  );
  app.use(
    '/api/auth/keys',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createAuthKeysRouter({
      serviceAccounts: saService,
      apiKeys: apiKeyService,
      ac: accessControl,
    }),
  );

  // -- Resource permissions: folders + cascade (W4 / T7) -----------------
  const folderService = new FolderService({
    folders: sharedFolderRepo,
    db: sqliteDb,
  });
  const resourcePermissionService = new ResourcePermissionService({
    roles: rbacRoleRepo,
    permissions: rbacPermissionRepo,
    userRoles: rbacUserRoles,
    teamRoles: rbacTeamRoles,
    folders: sharedFolderRepo,
    users: authRepos.users,
    teams: teamRepo,
  });
  // Mount T7.1 folder router BEFORE the legacy in-memory folder mount in
  // domain-routes.ts so the Grafana-parity routes win.
  app.use(
    '/api/folders',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createFolderRouter({
      folderService,
      permissionService: resourcePermissionService,
      ac: accessControl,
    }),
  );
  app.use(
    '/api/dashboards',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createDashboardPermissionsRouter({
      permissionService: resourcePermissionService,
      ac: accessControl,
      db: sqliteDb,
    }),
  );
  app.use(
    '/api/datasources',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createDatasourcePermissionsRouter({
      permissionService: resourcePermissionService,
      ac: accessControl,
    }),
  );
  app.use(
    '/api/access-control/alert.rules',
    authMw,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createAlertRulePermissionsRouter({
      permissionService: resourcePermissionService,
      ac: accessControl,
    }),
  );

  return { accessControl, sharedFolderRepo };
}
