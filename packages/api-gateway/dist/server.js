import express from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { cors } from './middleware/cors.js';
import { defaultRateLimiter, createRateLimiter } from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';
import { sessionsRouter } from './routes/sessions.js';
import { evidenceRouter } from './routes/evidence.js';
import { createInvestigationRouter, openApiRouter } from './routes/investigation/router.js';
import { createFeedRouter } from './routes/feed.js';
import { createIncidentRouter } from './routes/incident.js';
import { createSharedRouter } from './routes/shared.js';
import { createMetaRouter } from './routes/meta.js';
import { createApprovalRouter } from './routes/approval.js';
import { metricsRouter } from './routes/metrics.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createInvestigationReportRouter } from './routes/investigation-reports.js';
import { createSetupRouter } from './routes/setup.js';
import { datasourcesRouter } from './routes/datasources.js';
import { createAuthRouter } from './routes/auth.js';
import { createAdminRouter } from './routes/admin.js';
import { createQueryRouter } from './routes/dashboard/query.js';
import { createDashboardRouter } from './routes/dashboard/router.js';
import { createAlertRulesRouter } from './routes/alert-rules.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createIntentRouter } from './routes/intent.js';
import { createWorkspaceRouter } from './routes/workspaces.js';
import { createVersionRouter } from './routes/versions.js';
import { createFolderRouter } from './routes/folders.js';
import { createSearchRouter } from './routes/search.js';
import { createSqliteClient, createSqliteRepositories, ensureSchema, EventEmittingFeedRepository, EventEmittingApprovalRepository, EventEmittingAlertRuleRepository, defaultInvestigationStore, defaultInvestigationReportStore, defaultNotificationStore, defaultAlertRuleStore, defaultDashboardStore, defaultConversationStore, defaultShareStore, defaultFolderStore, defaultVersionStore, defaultWorkspaceStore, feedStore, incidentStore, approvalStore, postMortemStore, } from '@agentic-obs/data-layer';
import { createLogger, requestLogger, GracefulShutdown, ShutdownPriority } from '@agentic-obs/common';
import { registerStore, loadAll, flushStores, markDirty } from './persistence.js';
const log = createLogger('api-gateway');
const DATA_DIR = process.env['DATA_DIR'] || join(process.cwd(), '.uname-data');
function buildSqliteRepositories() {
    const dbPath = process.env['SQLITE_PATH'] || join(DATA_DIR, 'prism.db');
    const db = createSqliteClient({ path: dbPath });
    ensureSchema(db);
    return createSqliteRepositories(db);
}
function mountStaticAssets(app) {
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
function mountCommonRoutes(app) {
    app.use('/api/health', healthRouter);
    app.use('/api/sessions', sessionsRouter);
    app.use('/api/openapi.json', openApiRouter);
    app.use('/api/evidence', evidenceRouter);
    app.use('/api/webhooks', createWebhookRouter());
    app.use('/api/metrics', metricsRouter);
    app.use('/api/setup', createSetupRouter());
    app.use('/api/datasources', datasourcesRouter);
    app.use('/api/auth', createAuthRouter());
    app.use('/api/admin', createAdminRouter());
    app.use('/api/query', createQueryRouter());
}
export function createApp() {
    const app = express();
    // Parse JSON bodies
    app.use(express.json());
    // Structured request logging + correlation ID injection
    app.use(requestLogger);
    // CORS
    app.use(cors);
    // Rate limiting on all routes
    app.use(defaultRateLimiter);
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
        app.use('/api/incidents', createIncidentRouter({
            store: repos.incidents,
            investigationStore: repos.investigations,
            pmStore: repos.postMortems,
        }));
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
        app.use('/api/intent', createIntentRouter({
            dashboardStore: repos.dashboards,
            alertRuleStore: eventAlertRuleStore,
            investigationStore: repos.investigations,
            feedStore: eventFeedStore,
            reportStore: repos.investigationReports,
        }));
        app.use('/api/investigation-reports', createInvestigationReportRouter(repos.investigationReports));
        app.use('/api/dashboards', createDashboardRouter({
            store: repos.dashboards,
            conversationStore: repos.conversations,
            investigationReportStore: repos.investigationReports,
            alertRuleStore: eventAlertRuleStore,
        }));
        app.use('/api/alert-rules', createAlertRulesRouter({
            alertRuleStore: eventAlertRuleStore,
            investigationStore: repos.investigations,
            feedStore: eventFeedStore,
            reportStore: repos.investigationReports,
        }));
        app.use('/api/folders', createFolderRouter(repos.folders));
        app.use('/api/search', createSearchRouter({
            dashboardStore: repos.dashboards,
            alertRuleStore: eventAlertRuleStore,
            folderStore: repos.folders,
        }));
        app.use('/api/workspaces', createWorkspaceRouter({ store: repos.workspaces }));
        app.use('/api/versions', createVersionRouter(repos.versions));
        // Store repos on app for startServer to access
        app.__sqliteRepos = repos;
        app.__eventStores = { feedStore: eventFeedStore, approvalStore: eventApprovalStore, alertRuleStore: eventAlertRuleStore };
    }
    else {
        // -- Legacy in-memory mode with JSON persistence
        app.use('/api/investigations', createInvestigationRouter({
            store: defaultInvestigationStore,
            feed: feedStore,
            shareRepo: defaultShareStore,
            reportStore: defaultInvestigationReportStore,
        }));
        app.use('/api/feed', createFeedRouter(feedStore));
        app.use('/api/incidents', createIncidentRouter({
            store: incidentStore,
            investigationStore: defaultInvestigationStore,
            pmStore: postMortemStore,
        }));
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
        app.use('/api/intent', createIntentRouter({
            dashboardStore: defaultDashboardStore,
            alertRuleStore: defaultAlertRuleStore,
            investigationStore: defaultInvestigationStore,
            feedStore,
            reportStore: defaultInvestigationReportStore,
        }));
        app.use('/api/investigation-reports', createInvestigationReportRouter(defaultInvestigationReportStore));
        app.use('/api/dashboards', createDashboardRouter({
            store: defaultDashboardStore,
            conversationStore: defaultConversationStore,
            investigationReportStore: defaultInvestigationReportStore,
            alertRuleStore: defaultAlertRuleStore,
        }));
        app.use('/api/alert-rules', createAlertRulesRouter({
            alertRuleStore: defaultAlertRuleStore,
            investigationStore: defaultInvestigationStore,
            feedStore,
            reportStore: defaultInvestigationReportStore,
        }));
        app.use('/api/folders', createFolderRouter(defaultFolderStore));
        app.use('/api/search', createSearchRouter({
            dashboardStore: defaultDashboardStore,
            alertRuleStore: defaultAlertRuleStore,
            folderStore: defaultFolderStore,
        }));
        app.use('/api/workspaces', createWorkspaceRouter({ store: defaultWorkspaceStore }));
        app.use('/api/versions', createVersionRouter(defaultVersionStore));
    }
    mountStaticAssets(app);
    // 404 for unmatched routes
    app.use(notFoundHandler);
    // Centralized error handler (must be last)
    app.use(errorHandler);
    return app;
}
export function startServer(port = 3000) {
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
        // Start the proactive monitoring pipeline.
        void import('./proactive-pipeline-runner.js').then(async ({ runProactivePipeline }) => {
            await runProactivePipeline();
        }).catch((err) => {
            log.error({ err: err instanceof Error ? err.message : err }, 'proactive pipeline failed to start');
        });
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
        shutdown.register({
            name: 'proactive-pipeline',
            priority: ShutdownPriority.STOP_WORKERS,
            timeoutMs: 10_000,
            handler: async () => {
                const { setPipelineRunning } = await import('./routes/health.js');
                setPipelineRunning(false);
            },
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
//# sourceMappingURL=server.js.map