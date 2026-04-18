import express from 'express';
import type { Application } from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { cors } from './middleware/cors.js';
import { defaultRateLimiter, createRateLimiter } from './middleware/rate-limiter.js';
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
import { datasourcesRouter } from './routes/datasources.js';
import { createQueryRouter } from './routes/dashboard/query.js';
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
  EventEmittingFeedRepository,
  EventEmittingApprovalRepository,
  EventEmittingAlertRuleRepository,
  defaultInvestigationStore,
  defaultInvestigationReportStore,
  defaultNotificationStore,
  defaultAlertRuleStore,
  defaultDashboardStore,
  defaultConversationStore,
  defaultShareStore,
  defaultFolderStore,
  defaultVersionStore,
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
  createAuthMiddleware,
  setAuthMiddleware,
} from './middleware/auth.js';
import { createOrgContextMiddleware } from './middleware/org-context.js';
import { setBootstrapHasUsers, setSetupAdminDeps } from './routes/setup.js';
// Wave 2 / T3 — RBAC service, routes, resolvers.
import { AccessControlService } from './services/accesscontrol-service.js';
import { AccessControlHolder } from './services/accesscontrol-holder.js';
import { AuditWriter } from './auth/audit-writer.js';
import { createAccessControlRouter } from './routes/access-control.js';
import { createUserPermissionsRouter } from './routes/user-permissions.js';
import { createResolverRegistry } from './rbac/resolvers/index.js';
import type { SqliteRepositories } from '@agentic-obs/data-layer';
import { createLogger, requestLogger, GracefulShutdown, ShutdownPriority } from '@agentic-obs/common';
import { registerStore, loadAll, flushStores, markDirty } from './persistence.js';

const log = createLogger('api-gateway');

const DATA_DIR = process.env['DATA_DIR'] || join(process.cwd(), '.uname-data');

function buildSqliteRepositories(): SqliteRepositories & {
  _sqliteClient: ReturnType<typeof createSqliteClient>;
} {
  const dbPath = process.env['SQLITE_PATH'] || join(DATA_DIR, 'openobs.db');
  const db = createSqliteClient({ path: dbPath });
  ensureSchema(db);
  // Apply the name-based auth/perm migrations (001_org, 002_user, etc.).
  applyNamedMigrations(db);
  return Object.assign(createSqliteRepositories(db), { _sqliteClient: db });
}

function mountStaticAssets(app: Application): void {
  const webDistCandidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../web/dist'),
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

function mountCommonRoutes(app: Application): void {
  app.use('/api/health', healthRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/openapi.json', openApiRouter);
  app.use('/api/webhooks', createWebhookRouter());
  app.use('/api/metrics', metricsRouter);
  app.use('/api/setup', createSetupRouter());
  app.use('/api/datasources', datasourcesRouter);
  app.use('/api/query', createQueryRouter());
}

export function createApp(): Application {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Structured request logging + correlation ID injection
  app.use(requestLogger);

  // CORS
  app.use(cors);

  // Rate limiting on all routes
  app.use(defaultRateLimiter);

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

  // Determine persistence backend
  const dbUrl = process.env['DATABASE_URL'];
  const useSqlite = !dbUrl;

  // Mount common routes shared across all backends
  mountCommonRoutes(app);

  if (useSqlite) {
    // -- SQLite mode: all persistence via SQLite repos
    const repos = buildSqliteRepositories();
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
      setBootstrapHasUsers(async () => {
        const { total } = await authRepos.users.list({ limit: 1 });
        return total > 0;
      });
      // T9.4 — wire the setup-admin endpoint so /api/setup/admin can bootstrap
      // the first user while the wizard is open.
      setSetupAdminDeps({
        users: authRepos.users,
        orgs: authRepos.orgs,
        orgUsers: authRepos.orgUsers,
        sessions: authSub.sessions,
        audit: authSub.audit,
        defaultOrgId: 'org_main',
      });
      // Mount the auth / user / admin routers after the subsystem is built.
      // These endpoints are public or self-authenticating so mounting them
      // lazily is safe — requests that arrive before this resolves see a 503
      // from the auth-middleware shim, not an auth bypass.
      app.use(
        '/api/user',
        authMw,
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
        createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
        createUserPermissionsRouter(accessControl),
      );

      app.use(
        '/api/access-control',
        authMw,
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
        // Cross-org endpoints. orgContext middleware is omitted because
        // server-admin flows here (list-all, create new org) don't require
        // a specific current org.
        createOrgsRouter({ orgs: orgService, ac: accessControl }),
      );

      app.use(
        '/api/org',
        authMw,
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
        createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
        createUserTokensRouter({ apiKeys: apiKeyService }),
      );
      app.use(
        '/api/auth/keys',
        authMw,
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
        createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
        createDatasourcePermissionsRouter({
          permissionService: resourcePermissionService,
          ac: accessControl,
        }),
      );
      app.use(
        '/api/access-control/alert.rules',
        authMw,
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
    }));
    app.use('/api/feed', createFeedRouter(eventFeedStore));
    app.use('/api/shared', createSharedRouter({
      shareRepo: repos.shares,
      investigationStore: repos.investigations,
    }));
    app.use('/api/meta', createMetaRouter({
      investigationStore: repos.investigations,
      feedStore: eventFeedStore,
    }));
    app.use('/api/approvals', createApprovalRouter(eventApprovalStore));
    app.use('/api/notifications', createNotificationsRouter({
      notificationStore: repos.notifications,
      alertRuleStore: eventAlertRuleStore,
    }));
    app.use('/api/investigation-reports', createInvestigationReportRouter(repos.investigationReports));
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
    }));
    app.use('/api/alert-rules', createAlertRulesRouter({
      alertRuleStore: eventAlertRuleStore,
      investigationStore: repos.investigations,
      feedStore: eventFeedStore,
      reportStore: repos.investigationReports,
    }));
    // /api/folders is mounted above inside the async auth block — T7.1.
    app.use('/api/search', createSearchRouter({
      dashboardStore: repos.dashboards,
      alertRuleStore: eventAlertRuleStore,
      folderStore: repos.folders,
    }));
    app.use('/api/versions', createVersionRouter(repos.versions));
  } else {
    // -- Legacy in-memory mode with JSON persistence
    app.use('/api/investigations', createInvestigationRouter({
      store: defaultInvestigationStore,
      feed: feedStore,
      shareRepo: defaultShareStore,
      reportStore: defaultInvestigationReportStore,
    }));
    app.use('/api/feed', createFeedRouter(feedStore));
    app.use('/api/shared', createSharedRouter({
      shareRepo: defaultShareStore,
      investigationStore: defaultInvestigationStore,
    }));
    app.use('/api/meta', createMetaRouter({
      investigationStore: defaultInvestigationStore,
      feedStore,
    }));
    app.use('/api/approvals', createApprovalRouter(approvalStore));
    app.use('/api/notifications', createNotificationsRouter({
      notificationStore: defaultNotificationStore,
      alertRuleStore: defaultAlertRuleStore,
    }));
    app.use('/api/investigation-reports', createInvestigationReportRouter(defaultInvestigationReportStore));
    app.use('/api/dashboards', createDashboardRouter({
      store: defaultDashboardStore,
      conversationStore: defaultConversationStore,
      investigationReportStore: defaultInvestigationReportStore,
      alertRuleStore: defaultAlertRuleStore,
      investigationStore: defaultInvestigationStore,
      feedStore,
      accessControl: accessControlHolder,
      auditWriter: auditWriterHolder,
    }));
    app.use('/api/chat', createChatRouter({
      dashboardStore: defaultDashboardStore,
      conversationStore: defaultConversationStore,
      investigationReportStore: defaultInvestigationReportStore,
      alertRuleStore: defaultAlertRuleStore,
      investigationStore: defaultInvestigationStore,
      accessControl: accessControlHolder,
      auditWriter: auditWriterHolder,
    }));
    app.use('/api/alert-rules', createAlertRulesRouter({
      alertRuleStore: defaultAlertRuleStore,
      investigationStore: defaultInvestigationStore,
      feedStore,
      reportStore: defaultInvestigationReportStore,
    }));
    // Legacy in-memory mode doesn't get the Grafana-parity /api/folders —
    // that route only functions when SQLite is available (T7 migration 017
    // adds folder_uid columns that the in-memory path doesn't model).
    app.use('/api/search', createSearchRouter({
      dashboardStore: defaultDashboardStore,
      alertRuleStore: defaultAlertRuleStore,
      folderStore: defaultFolderStore,
    }));
    app.use('/api/versions', createVersionRouter(defaultVersionStore));
  }

  mountStaticAssets(app);

  // 404 + error handlers are mounted LAST, after every route registration
  // completes. For the sqlite branch, this happens in the auth IIFE's
  // `.finally()` above (because /api/user, /api/admin, etc. are added
  // asynchronously). For the legacy in-memory branch, we mount them here
  // since all routes in that path are synchronous.
  if (process.env['DATABASE_URL']) {
    app.use(notFoundHandler);
    app.use(errorHandler);
  }

  return app;
}

export function startServer(port = 3000): void {
  const app = createApp();
  const shutdown = new GracefulShutdown();
  const useSqlite = !process.env['DATABASE_URL'];

  if (!useSqlite) {
    // Legacy in-memory mode: load JSON persistence
    void (async () => {
      const { setMarkDirty } = await import('@agentic-obs/data-layer');
      setMarkDirty(markDirty);

      registerStore('dashboards', defaultDashboardStore);
      registerStore('alertRules', defaultAlertRuleStore);
      registerStore('conversations', defaultConversationStore);
      registerStore('investigationReports', defaultInvestigationReportStore);
      registerStore('investigations', defaultInvestigationStore);
      registerStore('shares', defaultShareStore);
      registerStore('notifications', defaultNotificationStore);
      registerStore('folders', defaultFolderStore);
      await loadAll();
      log.info('Persisted store data loaded');
    })().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : err }, 'failed to load persisted stores');
    });
  }

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

    // Flush in-memory stores to disk only in legacy mode
    if (!useSqlite) {
      shutdown.register({
        name: 'persistence-flush',
        priority: ShutdownPriority.STOP_WORKERS,
        timeoutMs: 5_000,
        handler: () => flushStores(),
      });
    }

    // Attach OS signal handlers
    shutdown.listen();
  }).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'websocket gateway failed to initialize');
  });
}
