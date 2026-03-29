import express from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { cors } from './middleware/cors.js';
import { defaultRateLimiter, createRateLimiter } from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';
import { sessionRouter } from './routes/session.js';
import { evidenceRouter } from './routes/evidence.js';
import { createInvestigationRouter, openApiRouter } from './routes/investigation/router.js';
import { createFeedRouter } from './routes/feed.js';
import { createIncidentRouter } from './routes/incident.js';
import { createSharedRouter } from './routes/shared.js';
import { metaRouter } from './routes/meta.js';
import { createApprovalRouter } from './routes/approval.js';
import { metricsRouter } from './routes/metrics.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createSetupRouter } from './routes/setup.js';
import { datasourcesRouter } from './routes/datasources.js';
import { createAuthRouter } from './routes/auth.js';
import { createAdminRouter } from './routes/admin.js';
import { feedRouter } from './routes/feed.js';
import { createQueryRouter } from './routes/dashboard/query.js';
import { createDashboardRouter } from './routes/dashboard/router.js';
import { alertRulesRouter } from './routes/alert-rules.js';
import { notificationsRouter } from './routes/notifications.js';
import { createIntentRouter } from './routes/intent.js';
import { createRepositories, createDbClient } from '@agentic-obs/data-layer';
import { createRepositories as createRepositoriesFactory } from './repositories/factory.js';
import { createLogger, requestLogger, GracefulShutdown, ShutdownPriority } from '@agentic-obs/common';
import { registerStore, loadAll, shutdown as flushStores } from './persistence.js';
const log = createLogger('api-gateway');
function buildRepositories() {
    const dbUrl = process.env['DATABASE_URL'];
    if (dbUrl) {
        const db = createDbClient({ url: dbUrl });
        return createRepositories('postgres', db);
    }
    return createRepositoriesFactory('memory');
}
export function createApp() {
    const app = express();
    // --- JSON bodies
    app.use(express.json());
    // app.use(requestLogger); // correlation ID injection
    // --- Core middleware / v1 routes
    app.use(cors);
    // Rate limiting on all routes
    app.use(defaultRateLimiter);
    // Relaxed rate limiter for dashboard query routes - panels fire many parallel
    // requests on load and on refresh intervals. 100 req/min (the default) is
    // trivially exceeded by a 30-panel dashboard. Allow 600 req/min on these
    // paths while keeping the tighter limit everywhere else.
    const queryRateLimiter = createRateLimiter({ windowMs: 60_000, max: 600 });
    // Create repositories - use Postgres when DATABASE_URL is set, otherwise InMemory
    const repos = buildRepositories();
    const stores = createRepositoriesFactory('memory');
    app.use('/api/health', healthRouter);
    app.use('/api/sessions', sessionRouter);
    app.use('/api/investigation', createInvestigationRouter({ store: stores.investigations, shareRepo: repos.shares }));
    app.use('/api/openapi.json', openApiRouter);
    app.use('/api', evidenceRouter);
    app.use('/api/feed', createFeedRouter(stores.feed));
    app.use('/api/feed', feedRouter);
    app.use('/api/incidents', createIncidentRouter(stores.incidents));
    app.use('/api', sharedRouter);
    app.use('/api/feedback', feedRouter);
    app.use('/api/meta', metaRouter);
    app.use('/api/approvals', createApprovalRouter(repos.approvals));
    app.use('/api/metrics', metricsRouter);
    app.use('/api', createWebhookRouter().router);
    app.use('/api/setup', createSetupRouter());
    app.use('/api/datasources', datasourcesRouter);
    app.use('/api/auth', createAuthRouter());
    app.use('/api/admin', createAdminRouter());
    app.use('/api/query', createQueryRouter());
    app.use('/api/dashboards', createDashboardRouter({ store: stores.dashboards }));
    app.use('/api/alert-rules', alertRulesRouter);
    app.use('/api/notifications', notificationsRouter);
    app.use('/api/intent', createIntentRouter(stores.dashboards));
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const webDistCandidates = [join(__dirname, '../web/dist'), join(__dirname, './web/dist')];
    const webDist = webDistCandidates.find(p => existsSync(p));
    if (webDist) {
        app.use(express.static(webDist));
        // SPA fallback: serve index.html for any non-API route
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api/')) {
                return next();
            }
            res.sendFile(join(webDist, 'index.html'));
        });
    }
    // 404 for unmatched routes
    app.use(notFoundHandler);
    // Centralized error handler (must be last)
    app.use(errorHandler);
    return app;
}
export function startServer(port = 3000) {
    const app = createApp();
    const shutdown = new GracefulShutdown();
    // Register all stores for JSON file persistence and load saved data
    void (async () => {
        const { defaultDashboardStore }, { defaultAlertRuleStore }, { defaultConversationStore }, { defaultInvestigationStore }, { defaultInvestigationReportStore }, { defaultShareStore }, { defaultNotificationStore } = await Promise.all([
            import('./routes/dashboard/store.js'),
            import('./routes/alert-rule-store.js'),
            import('./routes/dashboard/conversation-store.js'),
            import('./routes/investigation/store.js'),
            import('./routes/dashboard/investigation-report-store.js'),
            import('./routes/investigation/share-store.js'),
            import('./routes/notification-store.js'),
        ]);
        registerStore('dashboards', defaultDashboardStore);
        registerStore('alertRules', defaultAlertRuleStore);
        registerStore('conversations', defaultConversationStore);
        registerStore('investigations', defaultInvestigationStore);
        registerStore('investigationReports', defaultInvestigationReportStore);
        registerStore('shareStores', defaultShareStore);
        registerStore('notifications', defaultNotificationStore);
        await loadAll();
        log.info('Persisted store data loaded');
    })();
    // Wrap app as an http.Server + attach Socket.io WebSocket gateway
    void import('./websocket/gateway.js').then(({ createWebSocketGateway }) => {
        // Start proactive monitoring pipeline
        // Component are wired up lazily to avoid pulling them into the test environment
        void import('./proactive-pipeline-runner.js').then(async ({ runProactivePipeline }) => {
            await runProactivePipeline();
        });
        const { httpServer, gateway } = createWebSocketGateway(app);
        httpServer.listen(port, () => {
            log.info({ port }, 'API Gateway listening');
        });
        // 1. Stop accepting new HTTP + WebSocket connections
        shutdown.register({
            name: 'http-server',
            priority: ShutdownPriority.STOP_HTTP_SERVER,
            timeoutMs: 5_000,
            handler: () => new Promise((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve()))),
        });
        // 2. Close WebSocket gateway (drains subscriptions)
        shutdown.register({
            name: 'websocket-gateway',
            priority: ShutdownPriority.STOP_HTTP_SERVER,
            timeoutMs: 5_000,
            handler: () => gateway.close(),
        });
        // 3. Stop proactive pipeline (polls/timers)
        shutdown.register({
            name: 'proactive-pipeline',
            priority: ShutdownPriority.STOP_WORKERS,
            timeoutMs: 10_000,
            handler: async () => {
                const { setPipelineRunning } = await import('./routes/health.js');
                setPipelineRunning(false);
            },
        });
        // 4. Flush all in-memory stores to disk
        shutdown.register({
            name: 'persistence-flush',
            priority: ShutdownPriority.STOP_WORKERS,
            timeoutMs: 5_000,
            handler: flushStores,
        });
        // Catch OS signals/handlers
        shutdown.listen();
    });
}
//# sourceMappingURL=server.js.map
