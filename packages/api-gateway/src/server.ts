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
import { createShutdownHooks } from './app/lifecycle.js';

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
    }),
  );

  app.use(express.json());
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
  const bundle = await buildAuthSubsystem(persistence.sqliteDb);

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
    sqliteDb: persistence.sqliteDb,
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
  });

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
  const { httpServer, gateway } = createWebSocketGateway(app);

  httpServer.listen(port, () => {
    log.info({ port }, 'API gateway listening');
  });

  // -- Shutdown hooks ----------------------------------------------------
  const shutdown = createShutdownHooks(httpServer, gateway);
  shutdown.listen();
}
