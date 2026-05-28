/**
 * Domain-route wiring extracted from `server.ts::createApp()`.
 *
 * Mounts:
 *   - Common surface       — health, sessions, openapi, metrics, webhooks
 *   - Bootstrap-aware      — connectors, system, query (run pre-auth
 *                            during the wizard window, then auth-gated)
 *   - W6 business routes   — investigations, feed, shared, meta, approvals,
 *                            notifications,
 *                            dashboards, chat, alert-rules, search, versions
 *
 * The bootstrap-aware mounts depend on `setupConfigService` (built in
 * createApp before this is called) and on the `authMiddleware` singleton
 * (registered by `mountAuthRoutes` before this runs — by the time any
 * request arrives the singleton is bound).
 *
 * The pre-T7 in-memory permission shims (`AuditWriter` forwarder, etc.)
 * are gone — `createApp` now awaits the auth + RBAC setup synchronously,
 * so domain routers receive the resolved AccessControlService and
 * AuditWriter directly.
 */

import type { Application, RequestHandler } from 'express';
import {
  EventEmittingAlertRuleRepository,
  EventEmittingApprovalRepository,
  EventEmittingFeedRepository,
} from '@agentic-obs/data-layer';
import { PermissionLevel, type IFolderRepository } from '@agentic-obs/common';
import { healthRouter } from '../routes/health.js';
import { sessionsRouter } from '../routes/sessions.js';
import { metricsRouter } from '../routes/metrics.js';
import { createInvestigationRouter, openApiRouter } from '../routes/investigation/router.js';
import { createFeedRouter } from '../routes/feed.js';
import { createSharedRouter } from '../routes/shared.js';
import { createMetaRouter } from '../routes/meta.js';
import { createApprovalRouter } from '../routes/approval.js';
import { mountPlans } from './plans-boot.js';
import { createWebhookRouter } from '../routes/webhooks.js';
import { createConnectorsRouter } from '../routes/connectors.js';
import { createConnectorsGithubRouter } from '../routes/connectors-github.js';
import { testConnectorAgainstBackend } from '../services/connector-test.js';
import { getConnectorTemplate, type ConnectorType } from '@agentic-obs/common';
import { createQueryRouter } from '../routes/dashboard/query.js';
import { createMetricsQueryRouter } from '../routes/metrics-query.js';
import { createMetricsSaveAsDashboardRouter } from '../routes/metrics-save-as-dashboard.js';
import { createSystemRouter } from '../routes/system.js';
import { createDashboardRouter } from '../routes/dashboard/router.js';
import { createAdminPanelEventsRouter } from '../routes/admin-panel-events.js';
import { createPendingChangesRouter } from '../routes/pending-changes.js';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('domain-routes');
import { createKbEntriesRouter } from '../routes/kb-entries.js';
import type { IKnowledgeRepository } from '@agentic-obs/data-layer';
import { createAlertRulesRouter } from '../routes/alert-rules.js';
import { createNotificationsRouter } from '../routes/notifications.js';
import { createVersionRouter } from '../routes/versions.js';
import { createSearchRouter } from '../routes/search.js';
import { createChatRouter } from '../routes/chat.js';
import { SessionEventBus } from '../services/session-event-bus.js';
import { AgentRunRegistry } from '../services/agent-run-registry.js';
import { GithubAppTokenService } from '../services/github-app-token-service.js';
import { createOpsCommandConfirmationsRouter } from '../routes/ops-command-confirmations.js';
import { bootstrapAware } from '../middleware/bootstrap-aware.js';
import { authMiddleware } from '../middleware/auth.js';
import { createOrgContextMiddleware } from '../middleware/org-context.js';
import { SetupConfigService } from '../services/setup-config-service.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { ResourcePermissionService } from '../services/resource-permission-service.js';
import type { AuthSubsystem } from '../auth/auth-manager.js';
import type { AuthRepositories } from './auth-routes.js';
import type { Persistence } from './persistence.js';
import type { BackgroundRunnerDeps } from '@agentic-obs/agent-core';
import { isConnectorRepository } from '../services/connector-service.js';

export interface MountDomainRoutesDeps {
  app: Application;
  persistence: Persistence;
  authRepos: AuthRepositories;
  authSub: AuthSubsystem;
  accessControl: AccessControlService;
  setupConfig: SetupConfigService;
  sharedFolderRepo: IFolderRepository;
  userRateLimiter: RequestHandler;
  queryRateLimiter: RequestHandler;
  /**
   * Shared rule-store wrapper. When the caller (server.ts) lifts the
   * EventEmittingAlertRuleRepository up so the alert evaluator and the
   * domain routes share one event bus, it passes the wrapper here.
   * Otherwise we wrap locally — listeners in the local wrapper will not
   * see writes routed through any other wrapper.
   */
  eventAlertRuleStore?: EventEmittingAlertRuleRepository;
  /**
   * Background-agent runner. When provided, the manual Investigate button
   * on alert rules spawns an orchestrator run as the clicking user.
   * Without it the row is created but no agent runs.
   */
  runner?: BackgroundRunnerDeps;
  /**
   * Approval-request repo used by PlanExecutorService for per-step approval
   * submits. Wired at boot to a publishing wrapper so each `submit()`
   * publishes `approval.created` (T3.1). Falls back to `repos.approvals`.
   */
  approvalsForExecutor?: import('@agentic-obs/data-layer').IApprovalRequestRepository;
}

export function mountDomainRoutes(deps: MountDomainRoutesDeps): void {
  const {
    app,
    persistence,
    authRepos,
    authSub,
    accessControl,
    setupConfig,
    sharedFolderRepo,
    userRateLimiter,
    queryRateLimiter,
  } = deps;
  const { repos } = persistence;

  // -- Common surface (health, sessions, openapi, webhooks, metrics) ----
  app.use('/api/health', healthRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/openapi.json', openApiRouter);
  app.use('/api/webhooks', createWebhookRouter({ ac: accessControl }));
  app.use('/api/metrics', metricsRouter);
  // Relaxed rate limiter for dashboard query routes — must be on the
  // mount path BEFORE the bootstrap-aware auth chain.
  app.use('/api/query', queryRateLimiter);

  // -- Bootstrap-aware mounts (W2 / T2.5) -------------------------------
  //
  // connectors / system / query are reachable unauthenticated during
  // the setup-wizard window; once `bootstrapped_at` is written by
  // `POST /api/setup/admin`, auth + permission become mandatory.
  const bootstrapAwareAuthOnly = bootstrapAware({
    setupConfig,
    authMiddleware,
    preBootstrapAllowlist: [
      { method: 'POST', path: '/api/connectors' },
      { method: 'POST', path: /^\/api\/connectors\/[^/]+\/test$/ },
      { method: 'PUT', path: /^\/api\/connectors\/[^/]+$/ },
      { method: 'PUT', path: '/api/system/llm' },
      { method: 'PUT', path: '/api/system/notifications' },
    ],
    postAuthChain: [
      userRateLimiter,
      createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    ],
  });
  const connectorsRepo = connectorRepositoryOrUnavailable(repos);

  // GitHub OAuth flow — must be mounted BEFORE the main /api/connectors
  // router so its paths aren't shadowed by the generic /:id handlers.
  // /install-url requires auth (uses caller's orgId for state); /callback
  // is unauthenticated because GitHub redirects to it with no session.
  const githubAppBaseUrl = process.env['ROUNDS_BASE_URL']
    ?? process.env['APP_BASE_URL']
    ?? '';
  const upsertSecretFn = (repos as { connectors?: { upsertSecret?: (input: { connectorId: string; ciphertext: Uint8Array; keyVersion: number }) => Promise<unknown> } })
    .connectors?.upsertSecret;
  const githubAppConfigRepo = (repos as { githubAppConfig?: import('@agentic-obs/data-layer').IGithubAppConfigRepository }).githubAppConfig;
  if (typeof upsertSecretFn === 'function' && connectorsRepo.create && githubAppConfigRepo) {
    app.use(
      '/api/connectors/github',
      (req, res, next) => {
        // /callback and /manifest-callback are intentionally unauthenticated
        // (GitHub redirects to them with no session). Every other path
        // requires auth.
        if (req.path === '/callback' || req.path === '/manifest-callback') return next();
        return authMiddleware(req, res, next);
      },
      createConnectorsGithubRouter({
        createConnector: (input) => connectorsRepo.create(input),
        upsertSecret: upsertSecretFn,
        githubAppConfig: githubAppConfigRepo,
        appBaseUrl: githubAppBaseUrl,
      }),
    );
  }

  app.use(
    '/api/connectors',
    bootstrapAwareAuthOnly,
    createConnectorsRouter({
      connectors: connectorsRepo,
      secrets: optionalConnectorSecrets(repos),
      policies: optionalConnectorPolicies(repos),
      ac: accessControl,
      testConnector: async (connector) => {
        const template = getConnectorTemplate(connector.type as ConnectorType);
        let secret: string | null = null;
        if (template && template.credential !== 'none') {
          // Call as method (preserves `this`) — destructuring + invoking the
          // free function would lose context and trip `this.db is undefined`.
          const connectorRepo = repos.connectors as unknown as {
            getSecret?: (id: string) => Promise<{ ciphertext: Uint8Array } | null>;
          };
          if (typeof connectorRepo.getSecret === 'function') {
            try {
              const row = await connectorRepo.getSecret.call(connectorRepo, connector.id);
              if (row?.ciphertext) {
                secret = Buffer.from(row.ciphertext).toString('utf8');
              }
            } catch (err) {
              log.warn(
                { connectorId: connector.id, err: err instanceof Error ? err.message : String(err) },
                'connector test: failed to load secret',
              );
            }
          }
        }
        const result = await testConnectorAgainstBackend(connector, secret);
        // Cache: on success, flip draft → active. If repo.update isn't
        // available or the call fails, return the test result unchanged.
        if (result.ok && connectorsRepo.update) {
          try {
            await connectorsRepo.update(
              connector.id,
              {
                status: 'active',
                lastVerifiedAt: new Date().toISOString(),
                lastVerifyError: null,
              },
              connector.orgId,
            );
          } catch (err) {
            log.warn(
              { connectorId: connector.id, err: err instanceof Error ? err.message : String(err) },
              'connector test: failed to persist verified status',
            );
          }
        }
        // Map outcome → ConnectorTestResult. We intentionally don't use `error`
        // as a string here because the FE transport layer treats top-level
        // `error` as the canonical error envelope. Use `message` so the
        // response body stays a plain object that the FE can `'details' in`
        // check safely.
        return {
          ok: result.ok,
          ...(result.message ? { message: result.message } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
        };
      },
    }),
  );
  app.use(
    '/api/system',
    bootstrapAwareAuthOnly,
    createSystemRouter({
      setupConfig,
      ac: accessControl,
      notificationStore: repos.notifications,
    }),
  );
  app.use(
    '/api/query',
    authMiddleware,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createQueryRouter({ setupConfig, ac: accessControl, connectorRepo: repos.connectors }),
  );

  // -- W6 business routes ----------------------------------------------
  //
  // Wrap the relevant repos with event emitters so route handlers can
  // surface mutations on the shared pub/sub bus.
  const eventFeedStore = new EventEmittingFeedRepository(repos.feedItems);
  const eventApprovalStore = new EventEmittingApprovalRepository(repos.approvals);
  const eventAlertRuleStore = deps.eventAlertRuleStore
    ?? new EventEmittingAlertRuleRepository(repos.alertRules);
  const rbacRepos = deps.persistence.rbacRepos;
  const resourcePermissionService = new ResourcePermissionService({
    roles: rbacRepos.roles,
    permissions: rbacRepos.permissions,
    userRoles: rbacRepos.userRoles,
    teamRoles: rbacRepos.teamRoles,
    folders: rbacRepos.folders,
    users: authRepos.users,
    teams: rbacRepos.teams,
  });

  app.use('/api/investigations', createInvestigationRouter({
    store: repos.investigations,
    feed: eventFeedStore,
    shareRepo: repos.shares,
    reportStore: repos.investigationReports,
    ac: accessControl,
  }));
  app.use('/api/feed', createFeedRouter({
    store: eventFeedStore,
    ac: accessControl,
  }));
  app.use('/api/shared', createSharedRouter({
    shareRepo: repos.shares,
    investigationStore: repos.investigations,
  }));
  app.use('/api/meta', createMetaRouter({
    investigationStore: repos.investigations,
    feedStore: eventFeedStore,
    ac: accessControl,
  }));
  app.use('/api/approvals', createApprovalRouter({
    approvals: eventApprovalStore,
    approvalRequests: repos.approvals,
    ac: accessControl,
  }));

  // P5 — remediation-plan execution. Mounts /api/plans, builds the
  // PlanExecutorService, and subscribes to per-step ApprovalRequest
  // resolutions on the same approval bus the approvals router uses.
  mountPlans({
    app,
    plans: repos.remediationPlans,
    approvals: deps.approvalsForExecutor ?? repos.approvals,
    approvalEventStore: eventApprovalStore,
    connectors: repos.connectors,
    ac: accessControl,
    audit: authSub.audit,
    resolveRequesterTeamId: async (orgId, investigationId) => {
      const { list } = await eventAlertRuleStore.findAll();
      const rule = list.find((r) => r.investigationId === investigationId);
      if (!rule?.folderUid) return null;
      const entries = await resourcePermissionService.list(
        orgId,
        'alert.rules',
        rule.folderUid,
      );
      const teamEntry =
        entries.find((e) => e.teamId && e.permission >= PermissionLevel.Edit)
        ?? entries.find((e) => e.teamId);
      return teamEntry?.teamId ?? null;
    },
  });
  app.use('/api/notifications', createNotificationsRouter({
    notificationStore: repos.notifications,
    alertRuleStore: eventAlertRuleStore,
    ac: accessControl,
  }));
  // KB entries — unified skill-style CRUD. The knowledge repo arrives on
  // `repos` from B1's data-layer landing; if it's missing we skip mounting
  // and the route returns 404, which is honest about the feature being
  // unavailable.
  const knowledgeRepo = (repos as unknown as { knowledge?: IKnowledgeRepository }).knowledge;
  if (knowledgeRepo) {
    app.use('/api/kb/entries', createKbEntriesRouter({
      knowledge: knowledgeRepo,
      accessControl,
    }));
  }
  // Pending-changes router — must mount BEFORE the dashboard router so the
  // `/api/dashboards/:id/pending-changes*` paths aren't shadowed by the
  // catch-all `:id` handlers there. The router uses both `/api/dashboards/...`
  // and `/api/pending-changes/...` paths under a single Express base.
  app.use('/api', createPendingChangesRouter({
    pendingChanges: repos.pendingChanges,
    dashboards: repos.dashboards,
    accessControl,
    panelEvents: repos.panelEvents,
  }));
  // Background expiry sweep — once an hour, mark pending rows past their
  // expires_at as 'expired'. Wrapped in try/catch so a transient db blip
  // can't kill the process. Cadence overridable via env for tests.
  const pendingExpirySweepMs = Number(process.env['PENDING_CHANGES_SWEEP_MS']) || 60 * 60 * 1000;
  const pendingExpiryTimer = setInterval(() => {
    Promise.resolve()
      .then(() => repos.pendingChanges.expireOlderThan(new Date().toISOString()))
      .then((n) => {
        if (n > 0) log.info({ expired: n }, 'pending_changes: swept expired rows');
      })
      .catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'pending_changes: expireOlderThan threw',
        );
      });
  }, pendingExpirySweepMs);
  if (typeof pendingExpiryTimer.unref === 'function') pendingExpiryTimer.unref();
  app.use('/api/dashboards', createDashboardRouter({
    store: repos.dashboards,
    accessControl,
    setupConfig,
    audit: authSub.audit,
    panelEvents: repos.panelEvents,
  }));
  // Server-admin read API over the panel-events collection (offline lint
  // analysis bootstrap). Auth middleware is applied inside the router via
  // requireServerAdmin; we still want it behind the main authMiddleware so
  // `req.auth` is populated.
  app.use(
    '/api/admin/panel-events',
    authMiddleware,
    createAdminPanelEventsRouter({ panelEvents: repos.panelEvents }),
  );
  // Singletons that wire the detached-run architecture: chat events flow
  // through this bus AND get persisted; the registry tracks runs so a
  // client can disconnect without killing the agent. Both must be the same
  // instance across ChatService and the chat router for the live-tail
  // subscribe-then-replay handoff to work.
  const sessionEventBus = new SessionEventBus();
  const agentRunRegistry = new AgentRunRegistry();

  app.use('/api/chat', createChatRouter({
    dashboardStore: repos.dashboards,
    investigationReportStore: repos.investigationReports,
    alertRuleStore: eventAlertRuleStore,
    investigationStore: repos.investigations,
    chatSessionStore: repos.chatSessions,
    chatMessageStore: repos.chatMessages,
    chatEventStore: repos.chatSessionEvents,
    chatSessionContextStore: repos.chatSessionContexts,
    approvalStore: repos.approvals,
    remediationPlanStore: repos.remediationPlans,
    panelEventStore: repos.panelEvents,
    pendingChangeStore: repos.pendingChanges,
    knowledgeStore: repos.knowledge,
    accessControl,
    auditWriter: authSub.audit,
    folderRepository: sharedFolderRepo,
    setupConfig,
    llmAuditStore: repos.llmAudit,
    // Unified ops-connector model: the agent's ops_run_command tool reads
    // kubernetes connectors directly from the full data-layer repo (we want
    // `getSecret` here — the local `ConnectorRepository` view drops it).
    connectorRepo: repos.connectors,
    // GitHub agent tools (github_list_repos/_prs, github_get_pr/_diff).
    // The token service caches installation tokens in-process so each chat
    // turn doesn't pay a JWT-sign + 2x GitHub round-trip. Only wired when
    // the github_app_config repo is present (instance not registered → no
    // token service → handler reports "GitHub connector not configured").
    ...(githubAppConfigRepo
      ? {
          githubAppTokenService: new GithubAppTokenService({
            githubAppConfig: githubAppConfigRepo,
            connectors: repos.connectors,
          }),
        }
      : {}),
    sessionEventBus,
  }, {
    runRegistry: agentRunRegistry,
    sessionEventBus,
  }));
  app.use('/api/ops-command-confirmations', createOpsCommandConfirmationsRouter({
    connectors: repos.connectors,
    ac: accessControl,
  }));
  // Inline-chart metrics query — POST /api/metrics/query. Mounted after the
  // /api/metrics exposition router so the POST verb doesn't shadow the GET /.
  // Auth + per-datasource RBAC + 30/min rate limit are inside the router.
  app.use('/api/metrics', userRateLimiter, createMetricsQueryRouter({
    setupConfig,
    ac: accessControl,
    audit: authSub.audit,
    connectorRepo: repos.connectors,
  }));
  // PR-C — save inline chart as a dashboard panel (new or append).
  app.use('/api/metrics', userRateLimiter, createMetricsSaveAsDashboardRouter({
    dashboardStore: repos.dashboards,
    ac: accessControl,
    audit: authSub.audit,
  }));

  app.use('/api/alert-rules', createAlertRulesRouter({
    alertRuleStore: eventAlertRuleStore,
    investigationStore: repos.investigations,
    feedStore: eventFeedStore,
    reportStore: repos.investigationReports,
    setupConfig,
    ac: accessControl,
    audit: authSub.audit,
    connectorRepo: repos.connectors,
    ...(deps.runner ? { runner: deps.runner } : {}),
  }));
  // /api/folders is mounted in rbac-routes.ts (T7.1).
  app.use('/api/search', createSearchRouter({
    dashboardStore: repos.dashboards,
    alertRuleStore: eventAlertRuleStore,
    folderStore: sharedFolderRepo,
    orgUsers: authRepos.orgUsers,
    accessControl,
  }));
  app.use('/api/versions', createVersionRouter({
    store: repos.versions,
    dashboards: repos.dashboards,
    alertRules: eventAlertRuleStore,
    investigationReports: repos.investigationReports,
    ac: accessControl,
  }));
}

function connectorRepositoryOrUnavailable(repos: unknown): import('../services/connector-service.js').ConnectorRepository {
  const candidate = readRepo(repos, 'connectors');
  if (isConnectorRepository(candidate)) return candidate;
  return {
    async list() {
      throw new Error('ConnectorRepository is not wired yet');
    },
    async get() {
      throw new Error('ConnectorRepository is not wired yet');
    },
    async create() {
      throw new Error('ConnectorRepository is not wired yet');
    },
    async update() {
      throw new Error('ConnectorRepository is not wired yet');
    },
    async delete() {
      throw new Error('ConnectorRepository is not wired yet');
    },
  };
}

function optionalConnectorSecrets(repos: unknown): import('../services/connector-service.js').ConnectorSecretStore | undefined {
  const candidate = readRepo(repos, 'connectorSecrets');
  if (!candidate || typeof candidate !== 'object') return undefined;
  return typeof (candidate as { put?: unknown }).put === 'function'
    ? candidate as import('../services/connector-service.js').ConnectorSecretStore
    : undefined;
}

function optionalConnectorPolicies(repos: unknown): import('../services/connector-service.js').ConnectorPolicyRepository | undefined {
  const candidate = readRepo(repos, 'connectorPolicies');
  if (!candidate || typeof candidate !== 'object') return undefined;
  const maybe = candidate as Partial<Record<keyof import('../services/connector-service.js').ConnectorPolicyRepository, unknown>>;
  return typeof maybe.list === 'function' &&
    typeof maybe.upsert === 'function' &&
    typeof maybe.delete === 'function' &&
    typeof maybe.isAllowed === 'function'
    ? candidate as import('../services/connector-service.js').ConnectorPolicyRepository
    : undefined;
}

function readRepo(repos: unknown, key: string): unknown {
  return repos && typeof repos === 'object'
    ? (repos as Record<string, unknown>)[key]
    : undefined;
}
