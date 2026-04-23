import express from 'express';
import type { Application } from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { cors } from './middleware/cors.js';
import {
  defaultRateLimiter,
  createRateLimiter,
  createUserRateLimiter,
} from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';
import { sessionsRouter } from './routes/sessions.js';
import { createInvestigationRouter, openApiRouter } from './routes/investigation/router.js';
import { createFeedRouter } from './routes/feed.js';
import { createSharedRouter } from './routes/shared.js';
import { createMetaRouter } from './routes/meta.js';
import { createApprovalRouter } from './routes/approval.js';
import { metricsRouter } from './routes/metrics.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createInvestigationReportRouter } from './routes/investigation-reports.js';
import { createSetupRouter } from './routes/setup.js';
import { createDatasourcesRouter } from './routes/datasources.js';
import { createQueryRouter } from './routes/dashboard/query.js';
import { createSystemRouter } from './routes/system.js';
import { bootstrapAware } from './middleware/bootstrap-aware.js';
import { createDashboardRouter } from './routes/dashboard/router.js';
import { createAlertRulesRouter } from './routes/alert-rules.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createVersionRouter } from './routes/versions.js';
import { createOrgsRouter } from './routes/orgs.js';
import { createOrgRouter } from './routes/org.js';
import { createTeamsRouter } from './routes/teams.js';
import { OrgService } from './services/org-service.js';
import { TeamService } from './services/team-service.js';
import { ServiceAccountService } from './services/serviceaccount-service.js';
import { ApiKeyService } from './services/apikey-service.js';
import { createServiceAccountsRouter } from './routes/serviceaccounts.js';
import { createUserTokensRouter } from './routes/user-tokens.js';
import { createAuthKeysRouter } from './routes/auth-keys.js';
import { createFolderRouter } from './routes/folders.js';
import { createDashboardPermissionsRouter } from './routes/dashboard-permissions.js';
import { createDatasourcePermissionsRouter } from './routes/datasource-permissions.js';
import { createAlertRulePermissionsRouter } from './routes/alert-rule-permissions.js';
import { FolderService } from './services/folder-service.js';
import { ResourcePermissionService } from './services/resource-permission-service.js';
import { DashboardAclService } from './services/dashboard-acl-service.js';
import { createSearchRouter } from './routes/search.js';
import { createChatRouter } from './routes/chat.js';
import {
  createSqliteClient,
  createSqliteRepositories,
  ensureSchema,
  applyNamedMigrations,
  createDbClient,
  PostgresInstanceConfigRepository,
  PostgresDatasourceRepository,
  PostgresNotificationChannelRepository,
  applyPostgresInstanceMigrations,
  EventEmittingFeedRepository,
  EventEmittingApprovalRepository,
  EventEmittingAlertRuleRepository,
  feedStore,
  incidentStore,
  approvalStore,
  postMortemStore,
  UserRepository,
  UserAuthRepository,
  UserAuthTokenRepository,
  OrgRepository,
  OrgUserRepository,
  QuotaRepository,
  ApiKeyRepository,
  AuditLogRepository,
  PreferencesRepository,
  // Wave 2 / T3 RBAC
  RoleRepository,
  PermissionRepository,
  UserRoleRepository,
  TeamRoleRepository,
  TeamMemberRepository,
  TeamRepository,
  FolderRepository,
  DashboardAclRepository,
  seedRbacForOrg,
} from '@agentic-obs/data-layer';
import { createAuthSubsystem } from './auth/auth-manager.js';
import { seedAdminIfNeeded } from './auth/seed-admin.js';
import { migrateAuthToDbIfNeeded } from './migrations/auth-to-db.js';
import { createAuthRouter } from './routes/auth.js';
import { createUserRouter } from './routes/user.js';
import { createAdminRouter } from './routes/admin.js';
import {
  authMiddleware,
  createAuthMiddleware,
  setAuthMiddleware,
} from './middleware/auth.js';
import { createOrgContextMiddleware } from './middleware/org-context.js';
import { SetupConfigService } from './services/setup-config-service.js';
// Wave 2 / T3 — RBAC service, routes, resolvers.
import { AccessControlService } from './services/accesscontrol-service.js';
import { AccessControlHolder } from './services/accesscontrol-holder.js';
import type { AccessControlSurface } from './services/accesscontrol-holder.js';
import { AuditWriter } from './auth/audit-writer.js';
import { createAccessControlRouter } from './routes/access-control.js';
import { createUserPermissionsRouter } from './routes/user-permissions.js';
import { createResolverRegistry } from './rbac/resolvers/index.js';
import type { SqliteRepositories } from '@agentic-obs/data-layer';
import { createLogger, requestLogger } from '@agentic-obs/common/logging';
import { GracefulShutdown, ShutdownPriority } from '@agentic-obs/common/lifecycle';
import { dbPath } from './paths.js';

const log = createLogger('api-gateway');

function buildSqliteRepositories(): SqliteRepositories & {
  _sqliteClient: ReturnType<typeof createSqliteClient>;
} {
  // Use the shared resolver from ./paths.ts so the DB lives alongside
  // secrets.json in the same DATA_DIR.
  const db = createSqliteClient({ path: dbPath() });
  ensureSchema(db);
  // Apply the name-based auth/perm migrations (001_org, 002_user, etc.).
  applyNamedMigrations(db);
  return Object.assign(createSqliteRepositories(db), { _sqliteClient: db });
}

/**
 * T6.B — hybrid Postgres mode.
 *
 * When `DATABASE_URL` points at Postgres, the W2 instance-config stores
 * (LLM config, datasources, notification channels) move to Postgres while
 * the W6 stores (dashboards, investigations, alert rules, etc.) remain on
 * SQLite for this sprint. We do that by building the full SQLite repos
 * first and then swapping the three W2 fields with their Postgres siblings.
 *
 * Migrations run in a fire-and-forget IIFE so `createApp()` stays sync
 * (matching the auth subsystem pattern); if the migration fails we log and
 * surface it on first-query rather than blocking boot.
 *
 * Follow-ups owned by Wave 6 teams will port the remaining repos to
 * Postgres; until then operators who set `DATABASE_URL` still need a
 * writable DATA_DIR for the SQLite file that holds everything else.
 */
function buildPostgresRepositories(url: string): SqliteRepositories & {
  _sqliteClient: ReturnType<typeof createSqliteClient>;
} {
  const base = buildSqliteRepositories();
  const pg = createDbClient({ url });
  void applyPostgresInstanceMigrations(pg).catch((err) => {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'postgres instance-config migration failed',
    );
  });
  // Swap the three W2 repos.
  return {
    ...base,
    instanceConfig: new PostgresInstanceConfigRepository(pg),
    datasources: new PostgresDatasourceRepository(pg),
    notificationChannels: new PostgresNotificationChannelRepository(pg),
  };
}

function isPostgresUrl(url: string | undefined): url is string {
  return (
    typeof url === 'string' &&
    (url.startsWith('postgres://') || url.startsWith('postgresql://'))
  );
}

function mountStaticAssets(app: Application): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDistCandidates = [
    // Source-tree layout (packages/api-gateway/dist/server.js → packages/web/dist)
    join(here, '../../web/dist'),
    join(here, '../../../web/dist'),
    // Published npm layout (node_modules/openobs/dist/server.mjs → node_modules/openobs/web-dist)
    join(here, '../web-dist'),
  ];
  const webDist = webDistCandidates.find((p) => existsSync(p));
  if (webDist) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/'))
        return next();
      res.sendFile(join(webDist, 'index.html'));
    });
  }
}

function mountCommonRoutes(
  app: Application,
  deps: { ac: AccessControlSurface },
): void {
  app.use('/api/health', healthRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/openapi.json', openApiRouter);
  // Webhook subscription mgmt is admin-only — gated via the late-bound
  // `accessControlHolder`. The router itself constructs its
  // `requirePermission` upfront so handlers run after the holder is wired.
  app.use('/api/webhooks', createWebhookRouter({ ac: deps.ac }));
  app.use('/api/metrics', metricsRouter);
  // /api/setup, /api/datasources, and /api/query are mounted inside the
  // async auth IIFE below — they depend on SetupConfigService which needs
  // the sqlite repositories + audit writer, both built there.
}

export function createApp(): Application {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Structured request logging + correlation ID injection
  app.use(requestLogger);

  // CORS
  app.use(cors);

  // Rate limiting on all routes.
  //
  // Two layers cooperate:
  //   1. `defaultRateLimiter` (per-IP) — runs globally here, throttles the
  //      pre-auth surface where we have no user identity yet.
  //   2. `userRateLimiter` (per-userId) — mounted per-route immediately AFTER
  //      `authMw` in each authenticated chain, so behind a shared NAT each
  //      authenticated user gets their own bucket instead of sharing the IP
  //      bucket with every coworker on the same egress. The limiter's keyFn
  //      returns `null` when `req.auth` is absent (pre-auth request hit the
  //      wrong place), in which case it falls through to `next()`.
  //
  // We build the singleton here so every authenticated route shares one
  // bucket store (a user with 5 tabs shouldn't multiply their quota by 5
  // because each tab hits a different router).
  app.use(defaultRateLimiter);
  const userRateLimiter = createUserRateLimiter();

  // Wave 7 — permission gate dependencies. These are late-bound inside the
  // async auth-subsystem IIFE below; routers that need them receive the
  // holders now and the holders start forwarding once `.set()` is called.
  const accessControlHolder = new AccessControlHolder();
  // Audit writer is wrapped in a tiny forwarder so we can bind it late too.
  let resolvedAuditWriter: AuditWriter | null = null;
  const auditWriterHolder: AuditWriter = {
    log: async (entry) => {
      if (!resolvedAuditWriter) return;
      return resolvedAuditWriter.log(entry);
    },
  } as AuditWriter;

  // Relaxed rate limiter for dashboard query routes
  const queryRateLimiter = createRateLimiter({ windowMs: 60_000, max: 600 });
  app.use('/api/query', queryRateLimiter);

  // Determine persistence backend.
  //
  // Default: SQLite via DATA_DIR / SQLITE_PATH. Pure-sqlite install, no
  // connection pool to manage.
  //
  // Hybrid: DATABASE_URL=postgres(ql)://... moves the W2 instance-config
  // tables (LLM, datasources, notification channels) to Postgres; everything
  // else still lives in the SQLite file under DATA_DIR. See
  // `buildPostgresRepositories()` above and `postgres/README.md`.
  //
  // Any other DATABASE_URL value is ignored with a warning — historically
  // this env var gated an in-memory "no-persistence" mode that W2 deleted.
  const dbUrl = process.env['DATABASE_URL'];
  if (dbUrl && !isPostgresUrl(dbUrl)) {
    log.warn(
      { dbUrl: dbUrl.slice(0, 12) },
      'DATABASE_URL is set but does not start with postgres://; falling back to SQLite',
    );
  }

  // Mount common routes shared across all backends
  mountCommonRoutes(app, { ac: accessControlHolder });

  {
    // -- Persistence wiring (SQLite default, Postgres-hybrid when DATABASE_URL set)
    const repos = isPostgresUrl(dbUrl)
      ? buildPostgresRepositories(dbUrl)
      : buildSqliteRepositories();
    // — Auth subsystem wiring (Wave 2 / T2) ————————————————————————
    const sqliteDb = repos._sqliteClient;
    // T7 folder backend — shared across RBAC seeder (above in the auth block)
    // and chat/dashboard services (below) so agent folder.* tools reach the
    // same table UI folders use.
    const sharedFolderRepo = new FolderRepository(sqliteDb);
    const authRepos = {
      users: new UserRepository(sqliteDb),
      userAuth: new UserAuthRepository(sqliteDb),
      userAuthTokens: new UserAuthTokenRepository(sqliteDb),
      orgs: new OrgRepository(sqliteDb),
      orgUsers: new OrgUserRepository(sqliteDb),
      auditLog: new AuditLogRepository(sqliteDb),
      apiKeys: new ApiKeyRepository(sqliteDb),
      preferences: new PreferencesRepository(sqliteDb),
    };

    // W2 / T2.4 — instance-config service built synchronously. It uses
    // the `auditWriterHolder` forwarder for audit writes because the real
    // AuditWriter resolves inside the async auth IIFE below. The three
    // repositories don't depend on auth.
    const setupConfigService = new SetupConfigService({
      instanceConfig: repos.instanceConfig,
      datasources: repos.datasources,
      notificationChannels: repos.notificationChannels,
      audit: auditWriterHolder,
    });

    // Bootstrap-aware mounts (W2 / T2.5).
    //
    // `/api/datasources` + `/api/system/llm` + `/api/system/notifications`
    // are the post-W2 home for save operations the setup wizard used to
    // perform against `/api/setup/datasource` etc. The `bootstrapAware()`
    // middleware lets the wizard hit these unauthenticated while the
    // instance is still pre-bootstrap (no admin yet); once the first
    // admin is created the bootstrap marker locks the gate and auth +
    // permission become mandatory.
    //
    // `/api/query` is the live Prometheus proxy — no wizard use, always
    // authenticated.
    // The old blanket `requirePermission('dashboard:write')` on the
    // datasources mount was a mis-named legacy gate: datasource management
    // gets `dashboard:*` by mistake via Editor's wildcard, so a Viewer
    // promoted to Editor could silently add/edit/delete datasources. The
    // router now carries per-action `datasources:read / create / write /
    // delete` checks via `createRequirePermission(ac)`; here we only run
    // the pre-permission chain (authMiddleware + orgContext) inside
    // bootstrapAware so the wizard can still hit the routes unauthenticated
    // while the bootstrap marker is unset.
    const bootstrapAwareAuthOnly = bootstrapAware({
      setupConfig: setupConfigService,
      authMiddleware,
      postAuthChain: [
        userRateLimiter,
        createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
      ],
    });
    app.use(
      '/api/datasources',
      bootstrapAwareAuthOnly,
      createDatasourcesRouter({ setupConfig: setupConfigService, ac: accessControlHolder }),
    );
    // `/api/system` is gated inside its router via `instance.config:write`
    // (ADMIN_ONLY_PERMISSIONS in roles-def.ts). The legacy `admin:write`
    // hack that piggybacked on `datasources:write` is gone — see the W4
    // backend RBAC cleanup commit.
    app.use(
      '/api/system',
      bootstrapAwareAuthOnly,
      createSystemRouter({
        setupConfig: setupConfigService,
        ac: accessControlHolder,
      }),
    );
    app.use(
      '/api/query',
      authMiddleware,
      userRateLimiter,
      createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
      createQueryRouter({ setupConfig: setupConfigService }),
    );
    void (async () => {
      // T9.1 — idempotent auth-to-db migration on startup. Wraps the seed
      // admin step and records a marker so subsequent boots are no-ops.
      try {
        await migrateAuthToDbIfNeeded({
          db: sqliteDb,
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
    })();
    void (async () => {
      const authSub = await createAuthSubsystem(authRepos);
      // -- Wave 4 / T6.2 — ApiKeyService for SA tokens + PATs --------------
      const apiKeyService = new ApiKeyService({
        apiKeys: authRepos.apiKeys,
        users: authRepos.users,
        orgUsers: authRepos.orgUsers,
        quotas: new QuotaRepository(sqliteDb),
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

      // Mount the setup wizard router now that the auth subsystem has
      // resolved — it needs the real SessionService + AuditWriter for
      // the `POST /api/setup/admin` bootstrap flow. The service itself
      // was built earlier (synchronously) with the auditWriterHolder.
      app.use(
        '/api/setup',
        createSetupRouter({
          setupConfig: setupConfigService,
          users: authRepos.users,
          orgs: authRepos.orgs,
          orgUsers: authRepos.orgUsers,
          sessions: authSub.sessions,
          audit: authSub.audit,
          defaultOrgId: 'org_main',
          authMiddleware,
          ac: accessControlHolder,
        }),
      );

      // Mount the auth / user / admin routers after the subsystem is built.
      // These endpoints are public or self-authenticating so mounting them
      // lazily is safe — requests that arrive before this resolves see a 503
      // from the auth-middleware shim, not an auth bypass.
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
          defaultOrgId: 'org_main',
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
          quotas: new QuotaRepository(sqliteDb),
          defaultOrgId: 'org_main',
        }),
      );

      // -- Wave 2 / T3 — RBAC ------------------------------------------------
      // Construct the access-control service, seed the role catalog into the
      // default org (idempotent), and mount:
      //   - /api/user/permissions   (authenticated user's resolved perms)
      //   - /api/access-control/*   (role CRUD, assignments, etc.)
      const rbacRoleRepo = new RoleRepository(sqliteDb);
      const rbacPermissionRepo = new PermissionRepository(sqliteDb);
      const rbacUserRoles = new UserRoleRepository(sqliteDb);
      const rbacTeamRoles = new TeamRoleRepository(sqliteDb);
      const rbacTeamMembers = new TeamMemberRepository(sqliteDb);
      const rbacFolders = sharedFolderRepo;

      try {
        await seedRbacForOrg(sqliteDb, 'org_main');
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'seed rbac failed',
        );
      }

      // T7.6 — legacy dashboard_acl read-only fallback for RBAC evaluation.
      const dashboardAclRepo = new DashboardAclRepository(sqliteDb);
      const legacyAclService = new DashboardAclService({
        dashboardAcl: dashboardAclRepo,
        folders: rbacFolders,
        teamMembers: rbacTeamMembers,
        db: sqliteDb,
      });
      // Bind the audit-writer forwarder so the dashboard/chat routers can
      // emit `agent.tool_called` / `agent.tool_denied` rows.
      resolvedAuditWriter = authSub.audit;
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
            folders: rbacFolders,
            orgId,
            // Dashboard → folder_uid lookup so the dashboards resolver can
            // cascade a grant on a folder's scope to any dashboard it
            // contains. Raw SQL query keeps the dashboards repo out of scope.
            dashboardFolderUid: async (oid, dashUid) => {
              const rows = sqliteDb.all<{ folder_uid: string | null }>(
                sql`SELECT folder_uid FROM dashboards WHERE org_id = ${oid} AND id = ${dashUid} LIMIT 1`,
              );
              return rows[0]?.folder_uid ?? null;
            },
            alertRuleFolderUid: async (oid, ruleUid) => {
              const rows = sqliteDb.all<{ folder_uid: string | null }>(
                sql`SELECT folder_uid FROM alert_rules WHERE org_id = ${oid} AND id = ${ruleUid} LIMIT 1`,
              );
              return rows[0]?.folder_uid ?? null;
            },
          }),
      });
      // Bind the holder so the chat / dashboard agent permission gate starts
      // consulting the real RBAC service.
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

      // -- Wave 3 / T4.1 — Org CRUD + membership ----------------------------
      const quotasRepo = new QuotaRepository(sqliteDb);
      const orgService = new OrgService({
        orgs: authRepos.orgs,
        orgUsers: authRepos.orgUsers,
        users: authRepos.users,
        quotas: quotasRepo,
        audit: authSub.audit,
        db: sqliteDb,
        defaultOrgId: 'org_main',
      });

      app.use(
        '/api/orgs',
        authMw,
        userRateLimiter,
        // Cross-org endpoints. orgContext middleware is omitted because
        // server-admin flows here (list-all, create new org) don't require
        // a specific current org.
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

      // -- Wave 4 / T5.1 — Teams --------------------------------------------
      const teamService = new TeamService({
        teams: new TeamRepository(sqliteDb),
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

      // -- Wave 4 / T6 — Service accounts + tokens -------------------------
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

      // -- Wave 4 / T7 — Resource permissions (folders + cascade) ----------
      const folderService = new FolderService({
        folders: rbacFolders,
        db: sqliteDb,
      });
      const resourcePermissionService = new ResourcePermissionService({
        roles: rbacRoleRepo,
        permissions: rbacPermissionRepo,
        userRoles: rbacUserRoles,
        teamRoles: rbacTeamRoles,
        folders: rbacFolders,
        users: authRepos.users,
        teams: new TeamRepository(sqliteDb),
      });
      // Mount /api/folders T7.1 router BEFORE the legacy ones below so the
      // Grafana-parity routes win. The legacy in-memory store router is still
      // registered at the bottom for compat with in-memory mode.
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
    })()
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'failed to initialize auth subsystem',
        );
      })
      .finally(() => {
        // Mount 404 + error handlers LAST — after the async auth routes get
        // appended. Without this, notFoundHandler would capture requests
        // before the auth IIFE's app.use calls take effect.
        app.use(notFoundHandler);
        app.use(errorHandler);
      });

    // Wrap repos with event emitters for pub/sub
    const eventFeedStore = new EventEmittingFeedRepository(repos.feedItems);
    const eventApprovalStore = new EventEmittingApprovalRepository(repos.approvals);
    const eventAlertRuleStore = new EventEmittingAlertRuleRepository(repos.alertRules);

    app.use('/api/investigations', createInvestigationRouter({
      store: repos.investigations,
      feed: eventFeedStore,
      shareRepo: repos.shares,
      reportStore: repos.investigationReports,
      ac: accessControlHolder,
    }));
    app.use('/api/feed', createFeedRouter({
      store: eventFeedStore,
      ac: accessControlHolder,
    }));
    app.use('/api/shared', createSharedRouter({
      shareRepo: repos.shares,
      investigationStore: repos.investigations,
    }));
    app.use('/api/meta', createMetaRouter({
      investigationStore: repos.investigations,
      feedStore: eventFeedStore,
      ac: accessControlHolder,
    }));
    app.use('/api/approvals', createApprovalRouter({
      approvals: eventApprovalStore,
      ac: accessControlHolder,
    }));
    app.use('/api/notifications', createNotificationsRouter({
      notificationStore: repos.notifications,
      alertRuleStore: eventAlertRuleStore,
      ac: accessControlHolder,
    }));
    app.use('/api/investigation-reports', createInvestigationReportRouter({
      store: repos.investigationReports,
      ac: accessControlHolder,
    }));
    app.use('/api/dashboards', createDashboardRouter({
      store: repos.dashboards,
      conversationStore: repos.conversations,
      investigationReportStore: repos.investigationReports,
      alertRuleStore: eventAlertRuleStore,
      investigationStore: repos.investigations,
      feedStore: eventFeedStore,
      accessControl: accessControlHolder,
      auditWriter: auditWriterHolder,
      folderRepository: sharedFolderRepo,
      setupConfig: setupConfigService,
    }));
    app.use('/api/chat', createChatRouter({
      dashboardStore: repos.dashboards,
      conversationStore: repos.conversations,
      investigationReportStore: repos.investigationReports,
      alertRuleStore: eventAlertRuleStore,
      investigationStore: repos.investigations,
      chatSessionStore: repos.chatSessions,
      chatMessageStore: repos.chatMessages,
      chatEventStore: repos.chatSessionEvents,
      accessControl: accessControlHolder,
      auditWriter: auditWriterHolder,
      folderRepository: sharedFolderRepo,
      setupConfig: setupConfigService,
    }));
    app.use('/api/alert-rules', createAlertRulesRouter({
      alertRuleStore: eventAlertRuleStore,
      investigationStore: repos.investigations,
      feedStore: eventFeedStore,
      reportStore: repos.investigationReports,
      setupConfig: setupConfigService,
      ac: accessControlHolder,
    }));
    // /api/folders is mounted above inside the async auth block — T7.1.
    app.use('/api/search', createSearchRouter({
      dashboardStore: repos.dashboards,
      alertRuleStore: eventAlertRuleStore,
      folderStore: repos.folders,
    }));
    app.use('/api/versions', createVersionRouter({
      store: repos.versions,
      ac: accessControlHolder,
    }));
  }

  mountStaticAssets(app);

  // 404 + error handlers are mounted inside the auth IIFE's `.finally()`
  // above, once /api/user, /api/admin, etc. have been asynchronously
  // registered. Both SQLite and Postgres-hybrid branches share that path —
  // the repo-backend choice only affects which implementations back
  // `instance_llm_config` / `instance_datasources` / `notification_channels`.
  return app;
}

export function startServer(port = 3000): void {
  const app = createApp();
  const shutdown = new GracefulShutdown();

  // Wrap Express app in httpServer + attach Socket.io WebSocket gateway
  void import('./websocket/gateway.js').then(({ createWebSocketGateway }) => {
    const { httpServer, gateway } = createWebSocketGateway(app);

    httpServer.listen(port, () => {
      log.info({ port }, 'API gateway listening');
    });

    // -- Shutdown hooks (in priority order)
    shutdown.register({
      name: 'http-server',
      priority: ShutdownPriority.STOP_HTTP_SERVER,
      timeoutMs: 5_000,
      handler: () => new Promise((resolve, reject) => {
        httpServer.close((err) => err ? reject(err) : resolve(undefined));
      }),
    });

    shutdown.register({
      name: 'websocket-gateway',
      priority: ShutdownPriority.STOP_HTTP_SERVER,
      timeoutMs: 5_000,
      handler: () => gateway.close(),
    });

    // Attach OS signal handlers
    shutdown.listen();
  }).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'websocket gateway failed to initialize');
  });
}
