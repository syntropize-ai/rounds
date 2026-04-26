/**
 * Domain-route wiring extracted from `server.ts::createApp()`.
 *
 * Mounts:
 *   - Common surface       — health, sessions, openapi, metrics, webhooks
 *   - Bootstrap-aware      — datasources, system, query (run pre-auth
 *                            during the wizard window, then auth-gated)
 *   - W6 business routes   — investigations, feed, shared, meta, approvals,
 *                            notifications, investigation-reports,
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
  type FolderRepository,
} from '@agentic-obs/data-layer';
import { healthRouter } from '../routes/health.js';
import { sessionsRouter } from '../routes/sessions.js';
import { metricsRouter } from '../routes/metrics.js';
import { createInvestigationRouter, openApiRouter } from '../routes/investigation/router.js';
import { createFeedRouter } from '../routes/feed.js';
import { createSharedRouter } from '../routes/shared.js';
import { createMetaRouter } from '../routes/meta.js';
import { createApprovalRouter } from '../routes/approval.js';
import { createWebhookRouter } from '../routes/webhooks.js';
import { createInvestigationReportRouter } from '../routes/investigation-reports.js';
import { createDatasourcesRouter } from '../routes/datasources.js';
import { createQueryRouter } from '../routes/dashboard/query.js';
import { createSystemRouter } from '../routes/system.js';
import { createDashboardRouter } from '../routes/dashboard/router.js';
import { createAlertRulesRouter } from '../routes/alert-rules.js';
import { createNotificationsRouter } from '../routes/notifications.js';
import { createVersionRouter } from '../routes/versions.js';
import { createSearchRouter } from '../routes/search.js';
import { createChatRouter } from '../routes/chat.js';
import { bootstrapAware } from '../middleware/bootstrap-aware.js';
import { authMiddleware } from '../middleware/auth.js';
import { createOrgContextMiddleware } from '../middleware/org-context.js';
import { SetupConfigService } from '../services/setup-config-service.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import type { AuthSubsystem } from '../auth/auth-manager.js';
import type { AuthRepositories } from './auth-routes.js';
import type { Persistence } from './persistence.js';

export interface MountDomainRoutesDeps {
  app: Application;
  persistence: Persistence;
  authRepos: AuthRepositories;
  authSub: AuthSubsystem;
  accessControl: AccessControlService;
  setupConfig: SetupConfigService;
  sharedFolderRepo: FolderRepository;
  userRateLimiter: RequestHandler;
  queryRateLimiter: RequestHandler;
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
  // datasources / system / query are reachable unauthenticated during
  // the setup-wizard window; once `bootstrapped_at` is written by
  // `POST /api/setup/admin`, auth + permission become mandatory.
  const bootstrapAwareAuthOnly = bootstrapAware({
    setupConfig,
    authMiddleware,
    postAuthChain: [
      userRateLimiter,
      createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    ],
  });
  app.use(
    '/api/datasources',
    bootstrapAwareAuthOnly,
    createDatasourcesRouter({ setupConfig, ac: accessControl }),
  );
  app.use(
    '/api/system',
    bootstrapAwareAuthOnly,
    createSystemRouter({ setupConfig, ac: accessControl }),
  );
  app.use(
    '/api/query',
    authMiddleware,
    userRateLimiter,
    createOrgContextMiddleware({ orgUsers: authRepos.orgUsers }),
    createQueryRouter({ setupConfig }),
  );

  // -- W6 business routes ----------------------------------------------
  //
  // Wrap the relevant repos with event emitters so route handlers can
  // surface mutations on the shared pub/sub bus.
  const eventFeedStore = new EventEmittingFeedRepository(repos.feedItems);
  const eventApprovalStore = new EventEmittingApprovalRepository(repos.approvals);
  const eventAlertRuleStore = new EventEmittingAlertRuleRepository(repos.alertRules);

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
    ac: accessControl,
  }));
  app.use('/api/notifications', createNotificationsRouter({
    notificationStore: repos.notifications,
    alertRuleStore: eventAlertRuleStore,
    ac: accessControl,
  }));
  app.use('/api/investigation-reports', createInvestigationReportRouter({
    store: repos.investigationReports,
    ac: accessControl,
  }));
  app.use('/api/dashboards', createDashboardRouter({
    store: repos.dashboards,
    conversationStore: repos.conversations,
    investigationReportStore: repos.investigationReports,
    alertRuleStore: eventAlertRuleStore,
    investigationStore: repos.investigations,
    feedStore: eventFeedStore,
    accessControl,
    auditWriter: authSub.audit,
    folderRepository: sharedFolderRepo,
    setupConfig,
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
    accessControl,
    auditWriter: authSub.audit,
    folderRepository: sharedFolderRepo,
    setupConfig,
  }));
  app.use('/api/alert-rules', createAlertRulesRouter({
    alertRuleStore: eventAlertRuleStore,
    investigationStore: repos.investigations,
    feedStore: eventFeedStore,
    reportStore: repos.investigationReports,
    setupConfig,
    ac: accessControl,
  }));
  // /api/folders is mounted in rbac-routes.ts (T7.1).
  app.use('/api/search', createSearchRouter({
    dashboardStore: repos.dashboards,
    alertRuleStore: eventAlertRuleStore,
    folderStore: repos.folders,
  }));
  app.use('/api/versions', createVersionRouter({
    store: repos.versions,
    ac: accessControl,
  }));
}
