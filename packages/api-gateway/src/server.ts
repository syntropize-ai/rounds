/**
 * Express app factory + process entry point.
 *
 * `createApp()` is now end-to-end async — by the time it resolves, every
 * router (including the auth, RBAC, and W6 domain routes) is mounted and
 * ready to serve requests. This replaces the pre-T2 fire-and-forget IIFE
 * pattern that left a startup window where requests could land before
 * the auth middleware was bound. The 503 shim in `middleware/auth.ts`
 * covering that window is gone with this commit.
 *
 * Wiring lives in:
 *   - `app/persistence.ts`     — DB selection + repo construction
 *   - `app/auth-routes.ts`     — auth subsystem + login/setup/admin
 *   - `app/rbac-routes.ts`     — orgs/teams/folders + permission routers
 *   - `app/domain-routes.ts`   — investigations/dashboards/chat/etc.
 *   - `app/lifecycle.ts`       — shutdown hooks
 */

import express from 'express';
import type { Application } from 'express';
import helmet from 'helmet';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { cors } from './middleware/cors.js';
import { createCsrfMiddleware } from './middleware/csrf.js';
import {
  defaultRateLimiter,
  createRateLimiter,
  createUserRateLimiter,
} from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createLogger, requestLogger } from '@agentic-obs/common/logging';
import { AccessControlHolder } from './services/accesscontrol-holder.js';
import { SetupConfigService } from './services/setup-config-service.js';
import { createPersistence } from './app/persistence.js';
import { buildAuthSubsystem, mountAuthRoutes } from './app/auth-routes.js';
import { mountRbacRoutes } from './app/rbac-routes.js';
import { mountDomainRoutes } from './app/domain-routes.js';
import { startAlerts } from './app/alerts-boot.js';
import { createEventBusFromEnv } from '@agentic-obs/common/events';
import { NotificationConsumer } from './services/notification-consumer.js';
import { PublishingApprovalRepository } from './services/publishing-approval-repository.js';
import { ApprovalRouter } from './services/approval-router.js';
import { EventEmittingAlertRuleRepository } from '@agentic-obs/data-layer';
import { buildBackgroundOrchestratorFactory } from './app/agent-factory.js';
import { GitHubChangeSourceRegistry } from './services/github-change-source-service.js';
import { createShutdownHooks } from './app/lifecycle.js';
import type { WebSocketGatewayDeps } from './websocket/gateway.js';

const log = createLogger('api-gateway');

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

function mountGlobalMiddleware(app: Application): void {
  // -- Security headers (Helmet + CSP) ----------------------------------
  // MUST be the first middleware so headers are present even on responses
  // produced by error paths in later middleware.
  //
  // CSP: default-deny + an allowlist for the LLM API endpoints the chat /
  // investigation flows hit directly from the browser, plus localhost:11434
  // for Ollama. `script-src 'unsafe-inline'` is gated to development because
  // Vite injects an inline HMR shim during `vite dev`; the production bundle
  // emits hashed external scripts only.
  const isDev = process.env['NODE_ENV'] === 'development';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: [
            "'self'",
            'https://api.anthropic.com',
            'https://api.openai.com',
            'https://generativelanguage.googleapis.com',
            'http://localhost:11434',
          ],
          scriptSrc: isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        },
      },
      // Browsers default to no-referrer-when-downgrade; tighten so we never
      // leak query strings to upstream LLM providers.
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      hsts: isDev
        ? false
        : {
            maxAge: 15552000,
            includeSubDomains: true,
          },
    }),
  );

  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));
  app.use(requestLogger);
  app.use(cors);
  // CSRF — double-submit cookie. Mounts BEFORE auth middleware so we can
  // set the cookie on the same response that returns from a session-
  // establishing GET. First-contact auth endpoints (`/api/login`, OAuth
  // callbacks, SAML ACS) are exempt — they have their own anti-CSRF
  // (state param / RelayState) and the user has no session cookie yet.
  app.use(createCsrfMiddleware());

  // Rate limiting on all routes. The per-user limiter is built in
  // createApp and wired per-route by the auth/rbac/domain mounters so
  // every authenticated route shares one bucket store (a user with 5
  // tabs shouldn't multiply their quota by 5 because each tab hits a
  // different router).
  app.use(defaultRateLimiter);
}

export async function createApp(): Promise<Application> {
  const app = express();

  mountGlobalMiddleware(app);

  const userRateLimiter = createUserRateLimiter();
  const queryRateLimiter = createRateLimiter({ windowMs: 60_000, max: 600 });

  // -- Persistence -------------------------------------------------------
  const persistence = await createPersistence();

  // -- Auth subsystem (no routes mounted yet) ---------------------------
  // Builds AuthSubsystem + ApiKeyService and binds the global
  // authMiddleware singleton. The 503 shim that used to cover the
  // pre-binding window is no longer reachable from createApp.
  const bundle = await buildAuthSubsystem(
    persistence.db,
    persistence.authRepos,
    persistence.rbacRepos,
    persistence.rbacRepos.quotas,
  );

  // W2 / T2.4 — instance-config service. Built AFTER the auth subsystem
  // so config-mutation events can be audited via `authSub.audit`.
  const setupConfig = new SetupConfigService({
    instanceConfig: persistence.repos.instanceConfig,
    datasources: persistence.repos.datasources,
    notificationChannels: persistence.repos.notificationChannels,
    audit: bundle.authSub.audit,
  });

  // The AccessControlHolder lets webhooks/etc. receive an
  // `AccessControlSurface` reference at construction time; the real
  // service is built inside mountRbacRoutes which calls `.set()` on it.
  const accessControlHolder = new AccessControlHolder();

  // -- Auth routes (setup wizard, login/OAuth, current user, admin) -----
  mountAuthRoutes({
    app,
    db: persistence.db,
    quotas: persistence.rbacRepos.quotas,
    bundle,
    setupConfig,
    ac: accessControlHolder,
    userRateLimiter,
  });

  // -- RBAC + orgs/teams/SAs/folders ------------------------------------
  const { accessControl, sharedFolderRepo } = await mountRbacRoutes({
    app,
    persistence,
    authRepos: bundle.authRepos,
    authSub: bundle.authSub,
    authMw: bundle.authMw,
    apiKeyService: bundle.apiKeyService,
    userRateLimiter,
    accessControlHolder,
  });

  // Lift the rule-store event wrapper up to createApp so the domain
  // routes (write path) and the alert evaluator (read/refresh path)
  // share one event bus — a rule created via the API hits the
  // evaluator's hot-reload listener through this wrapper.
  const eventAlertRuleStore = new EventEmittingAlertRuleRepository(
    persistence.repos.alertRules,
  );
  const githubChangeSources = new GitHubChangeSourceRegistry(persistence.repos.changeSources);

  // Event bus — Redis when REDIS_URL is set, in-memory otherwise. Both
  // the AutoInvestigationConsumer and the NotificationConsumer subscribe
  // to `alert.fired` here; the AlertEvaluator publishes to it on every
  // rule transition into firing.
  const eventBus = createEventBusFromEnv();
  app.locals['eventBus'] = eventBus;

  // Wrap the approval-request repo so a successful `submit()` publishes
  // `approval.created` on the bus (T3.1 / approvals-multi-team-scope §3.7).
  // Both the agent-core remediation-plan handler (plan-level approvals) and
  // PlanExecutorService (per-step approvals) write through this wrapper, so
  // the NotificationConsumer below sees every new approval row.
  const publishingApprovals = new PublishingApprovalRepository({
    inner: persistence.repos.approvals,
    bus: eventBus,
    orgId: 'org_main',
  });

  // Background-agent runner — shared by both the auto-investigation
  // dispatcher (alert.fired -> agent run) and the manual Investigate
  // button on alert rules. Built once so both paths use the same
  // orchestrator factory + SA token resolver.
  const backgroundRunner = {
    saTokens: bundle.apiKeyService,
    makeOrchestrator: buildBackgroundOrchestratorFactory({
      persistence,
      approvalsOverride: publishingApprovals,
      setupConfig,
      accessControl,
      audit: bundle.authSub.audit,
      folderRepository: sharedFolderRepo,
      githubChangeSources,
    }),
  };

  // -- W6 business routes + bootstrap-aware mounts ----------------------
  mountDomainRoutes({
    app,
    persistence,
    authRepos: bundle.authRepos,
    authSub: bundle.authSub,
    accessControl,
    setupConfig,
    sharedFolderRepo,
    userRateLimiter,
    queryRateLimiter,
    eventAlertRuleStore,
    githubChangeSources,
    runner: backgroundRunner,
    approvalsForExecutor: publishingApprovals,
  });

  // Start the periodic alert evaluator (Phase 0.5 boot path). Behind
  // ALERT_EVALUATOR_ENABLED (default true). The handle is parked on
  // app.locals so a graceful-shutdown caller (or a future AutoInvestigation
  // dispatcher) can reach the evaluator without rebuilding it.
  app.locals['alertsHandle'] = await startAlerts({
    rules: eventAlertRuleStore,
    setupConfig,
    db: persistence.db,
    investigations: persistence.repos.investigations,
    authRepos: {
      users: bundle.authRepos.users,
      orgUsers: bundle.authRepos.orgUsers,
      apiKeys: bundle.authRepos.apiKeys,
    },
    subscribeRuleChanges: (cb) => {
      eventAlertRuleStore.onChange(() => cb());
    },
    runner: backgroundRunner,
    eventBus,
  });

  // Notification fan-out (slack / webhook / discord / teams) — subscribes
  // to `alert.fired` on the same bus. Routing tree + group/repeat windows
  // are read live, so policy edits in the UI take effect on the next fire
  // without restarting.
  // ApprovalRouter resolves users from RBAC for approval.created routing
  // (approvals-multi-team-scope §3.7). Shares the auth repos with
  // AccessControlService — same source of truth for visibility + notify.
  const approvalRouter = new ApprovalRouter({
    permissions: persistence.rbacRepos.permissions,
    roles: persistence.rbacRepos.roles,
    userRoles: persistence.rbacRepos.userRoles,
    teamRoles: persistence.rbacRepos.teamRoles,
    teamMembers: persistence.rbacRepos.teamMembers,
    orgUsers: bundle.authRepos.orgUsers,
  });

  const notificationConsumer = new NotificationConsumer({
    bus: eventBus,
    notifications: persistence.repos.notifications,
    notificationDispatch: persistence.repos.notificationDispatch,
    approvalRouter,
    teamMembers: persistence.rbacRepos.teamMembers,
  });
  notificationConsumer.start();
  app.locals['notificationConsumer'] = notificationConsumer;

  app.locals['websocketGatewayDeps'] = {
    auth: {
      sessions: bundle.authSub.sessions,
      users: bundle.authRepos.users,
      orgUsers: bundle.authRepos.orgUsers,
      apiKeyService: bundle.apiKeyService,
    },
    authorization: {
      ac: accessControl,
      resources: {
        investigations: persistence.repos.investigations,
        incidents: persistence.repos.incidents,
        approvals: persistence.repos.approvals,
        feedItems: persistence.repos.feedItems,
      },
    },
  } satisfies WebSocketGatewayDeps;

  // -- Demo mode (zero-credential preview) ------------------------------
  // OPENOBS_DEMO=1 is the ONLY way to enable demo routes. The flag is
  // read here, not inside the router module, so the router cannot be
  // silently mounted by a stray import.
  if (process.env['OPENOBS_DEMO'] === '1') {
    const { createDemoRouter } = await import('./routes/demo.js');
    app.use('/api/demo', createDemoRouter());
    log.info('OPENOBS_DEMO=1 — demo routes mounted at /api/demo');
  }

  // -- SPA fallback + 404 / error handlers (must be LAST) ---------------
  mountStaticAssets(app);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export async function startServer(port = 3000): Promise<void> {
  const app = await createApp();

  // Wrap Express app in httpServer + attach Socket.io WebSocket gateway
  const { createWebSocketGateway } = await import('./websocket/gateway.js');
  const { createEventBusFromEnv } = await import('@agentic-obs/common/events');
  const wsDeps = app.locals['websocketGatewayDeps'] as WebSocketGatewayDeps | undefined;
  const { httpServer, gateway } = createWebSocketGateway(app, createEventBusFromEnv(), wsDeps);

  // Friendly listen errors. Without an `error` handler, Node crashes the
  // process with an unhandled-event stack trace on EADDRINUSE — bad UX for
  // the common "I already have something on :3000" case. Catch the two
  // listen errors a user can actually do something about and print a
  // prescriptive one-liner instead of the raw trace.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\nopenobs: port ${port} is already in use.\n\n` +
        `  • Kill what's holding it:   lsof -ti :${port} | xargs kill\n` +
        `  • Or run on another port:   PORT=${port + 1} openobs\n\n`,
      );
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      process.stderr.write(
        `\nopenobs: permission denied to bind port ${port}.\n` +
        `Pick a port ≥1024 or run with elevated privileges.\n` +
        `  PORT=8080 openobs\n\n`,
      );
      process.exit(1);
    }
    log.fatal({ err: err.message, code: err.code }, 'listen failed');
    process.exit(1);
  });

  httpServer.listen(port, () => {
    log.info({ port }, 'API gateway listening');
  });

  // -- Shutdown hooks ----------------------------------------------------
  const shutdown = createShutdownHooks(httpServer, gateway);
  shutdown.listen();
}
