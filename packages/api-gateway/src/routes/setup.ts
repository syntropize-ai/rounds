/**
 * Setup wizard routes (W2 / T2.5).
 *
 * Pre-W2 this router owned `inMemoryConfig` + read/write of
 * `<DATA_DIR>/setup-config.json`. That whole layer is deleted — LLM /
 * datasources / notifications now live in SQLite (see migration 019)
 * and go through `SetupConfigService`.
 *
 * After T2.5 the save endpoints moved out of `/api/setup/*`:
 *   - `POST /api/setup/datasource` (save)             → POST /api/datasources
 *   - `DELETE /api/setup/datasource/:id`              → DELETE /api/datasources/:id
 *   - `POST /api/setup/llm` (save)                    → PUT /api/system/llm
 *   - `POST /api/setup/notifications` (save)          → PUT /api/system/notifications
 *
 * All three new endpoints are wrapped in `bootstrapAware()` middleware so
 * the wizard (pre-first-admin) can still hit them unauthenticated; once
 * the bootstrap marker is set, auth + permission become mandatory.
 *
 * What's left here:
 *   - `GET  /status`            readiness view derived from DB (T2.6)
 *   - `GET  /config`            current config with secrets masked
 *   - `POST /admin`             first-admin bootstrap (writes the marker)
 *   - `POST /llm/test`          test-connection probe
 *   - `POST /llm/models`        provider model-list probe
 *   - `POST /reset`             dev utility (clears all instance config)
 *
 * `POST /api/setup/complete` is gone (T2.6): readiness is derived from
 * `hasAdmin && hasLLM`, not a stored flag. Clients should read
 * `GET /api/setup/status` instead of posting a no-op.
 */

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type {
  IOrgRepository,
  IOrgUserRepository,
  IUserRepository,
  LlmConfigWire,
  NotificationsWire,
} from '@agentic-obs/common';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { createRateLimiter, loginRateLimiter } from '../middleware/rate-limiter.js';
import { bootstrapAware } from '../middleware/bootstrap-aware.js';
import type { SessionService } from '../auth/session-service.js';
import { SESSION_COOKIE_NAME } from '../auth/session-service.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import {
  SetupBootstrapService,
  SetupBootstrapServiceError,
} from '../services/setup-bootstrap-service.js';
import {
  SetupLlmService,
  SetupLlmServiceError,
} from '../services/setup-llm-service.js';

const log = createLogger('setup');

// Wire shapes `LlmConfigWire` and `NotificationsWire` are owned by
// `@agentic-obs/common/models/wire-config` (T3.3) so the web frontend
// and the api-gateway agree on the HTTP request/response format.

async function readNotificationsAsDto(service: SetupConfigService): Promise<NotificationsWire | undefined> {
  const channels = await service.listNotificationChannels({ masked: true });
  if (channels.length === 0) return undefined;
  const dto: NotificationsWire = {};
  for (const c of channels) {
    if (c.config.kind === 'slack') dto.slack = { webhookUrl: c.config.webhookUrl };
    else if (c.config.kind === 'pagerduty')
      dto.pagerduty = { integrationKey: c.config.integrationKey };
    else if (c.config.kind === 'email')
      dto.email = {
        host: c.config.host,
        port: c.config.port,
        username: c.config.username,
        password: c.config.password,
        from: c.config.from,
      };
  }
  return dto;
}

// -- Bootstrap access -----------------------------------------------

export interface SetupRouterDeps {
  setupConfig: SetupConfigService;
  users: IUserRepository;
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
  sessions: SessionService;
  audit: AuditWriter;
  defaultOrgId?: string;
  /**
   * Required for the post-bootstrap half of `/api/setup/*`: once the
   * instance has an admin, probe endpoints (`/llm/test`, `/llm/models`,
   * `/config`, `/reset`) still need to work — but only for authed
   * callers. The wizard's own admin-creation response sets a session
   * cookie, so the same browser can continue the wizard without a
   * separate /login round-trip.
   */
  authMiddleware: RequestHandler;
  /**
   * RBAC surface. Used to gate the destructive `POST /reset` endpoint
   * behind `instance.config:write` once the instance is bootstrapped.
   * Pre-bootstrap the bootstrap-aware middleware still lets the wizard
   * through unauthenticated.
   */
  ac: AccessControlSurface;
}

const setupRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
});

// -- Router ---------------------------------------------------------

export function createSetupRouter(deps: SetupRouterDeps): Router {
  const router = Router();
  const { setupConfig } = deps;
  const requirePermission = createRequirePermission(deps.ac);
  const bootstrapService = new SetupBootstrapService({
    setupConfig,
    users: deps.users,
    orgs: deps.orgs,
    orgUsers: deps.orgUsers,
    sessions: deps.sessions,
    audit: deps.audit,
    defaultOrgId: deps.defaultOrgId,
  });
  const llmService = new SetupLlmService();
  // Pre-bootstrap: probe endpoints run open so the wizard can test a
  // provider before the first admin exists. Post-bootstrap: the normal
  // auth middleware kicks in — the admin-creation response sets a
  // session cookie so the same browser continues the wizard authed.
  // Hard-closing after bootstrap (the earlier pattern) broke the
  // wizard's LLM step because the in-browser session cookie never
  // reached the handler.
  const requireSetupAccess = bootstrapAware({
    setupConfig,
    authMiddleware: deps.authMiddleware,
  });
  const requirePostBootstrapPermission = (
    evaluator: ReturnType<typeof ac.eval>,
  ): RequestHandler => {
    const permissionGate = requirePermission(evaluator);
    return async (req, res, next) => {
      try {
        if (!(await setupConfig.isBootstrapped())) {
          next();
          return;
        }
        permissionGate(req, res, next);
      } catch (err) {
        next(err);
      }
    };
  };
  const requireConfigRead = requirePostBootstrapPermission(
    ac.eval(ACTIONS.InstanceConfigRead),
  );
  const requireConfigWrite = requirePostBootstrapPermission(
    ac.eval(ACTIONS.InstanceConfigWrite),
  );

  router.use(setupRateLimiter);

  // GET /api/setup/status — DB-derived readiness view (T2.6).
  //
  // `configured` used to be a persisted boolean flipped by `POST /complete`.
  // That endpoint is gone; readiness is now derived from actual state:
  //   `configured = hasAdmin && hasLLM`.
  // `configuredAt` is a best-effort breadcrumb stamped when all three
  // pieces first align — purely informational, not a gate.
  router.get('/status', async (_req: Request, res: Response) => {
    let hasAdmin = false;
    try {
      const { total } = await deps.users.list({ limit: 1 });
      hasAdmin = total > 0;
    } catch (err) {
      log.warn({ err }, 'hasAdmin probe failed');
    }
    try {
      const status = await setupConfig.getStatus(hasAdmin);
      const configured = status.hasAdmin && status.hasLLM;
      // Stamp `configured_at` the first time we become ready, so clients
      // that want to know "when did this instance finish setup" have an
      // answer without having to correlate multiple timestamps. Stamped
      // on read so there's no new write endpoint required from the wizard.
      let configuredAt = status.configuredAt;
      if (configured && !configuredAt) {
        const now = new Date().toISOString();
        await setupConfig.setConfiguredAt(now);
        configuredAt = now;
      }
      res.json({
        configured,
        hasAdmin: status.hasAdmin,
        hasLLM: status.hasLLM,
        datasourceCount: status.datasourceCount,
        hasNotifications: status.hasNotifications,
        bootstrappedAt: status.bootstrappedAt,
        configuredAt,
      });
    } catch (err) {
      log.error({ err }, 'setup status failed');
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'setup status unavailable' },
      });
    }
  });

  // POST /api/setup/admin — first-admin bootstrap. Writes the `bootstrapped_at`
  // marker on success (T2.7), which permanently closes the setup gate.
  router.post('/admin', loginRateLimiter, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        email?: string;
        name?: string;
        login?: string;
        password?: string;
      };
      const userAgent = typeof req.headers['user-agent'] === 'string'
        ? (req.headers['user-agent'] as string)
        : '';
      const result = await bootstrapService.createFirstAdmin({
        ...body,
        userAgent,
        ip: (req.ip || req.socket?.remoteAddress || '') as string,
      });
      res.setHeader(
        'Set-Cookie',
        [
          `${SESSION_COOKIE_NAME}=${result.sessionToken}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          process.env['NODE_ENV'] === 'production' ? 'Secure' : '',
        ]
          .filter(Boolean)
          .join('; '),
      );
      res.status(201).json({ userId: result.userId, orgId: result.orgId });
    } catch (err) {
      if (err instanceof SetupBootstrapServiceError) {
        res.status(err.kind === 'conflict' ? 409 : 400).json({
          error: {
            code: err.kind === 'conflict' ? 'CONFLICT' : 'VALIDATION',
            message: err.message,
          },
        });
        return;
      }
      throw err;
    }
  });

  router.use(requireSetupAccess);

  // GET /api/setup/config — returns current config (secrets masked).
  router.get('/config', requireConfigRead, async (_req: Request, res: Response) => {
    try {
      const [llm, datasources, notifications] = await Promise.all([
        setupConfig.getLlm({ masked: true }),
        setupConfig.listDatasources({ masked: true }),
        readNotificationsAsDto(setupConfig),
      ]);
      res.json({
        llm: llm ?? undefined,
        datasources,
        notifications,
      });
    } catch (err) {
      log.error({ err }, 'GET /api/setup/config failed');
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'config read failed' },
      });
    }
  });

  // POST /api/setup/llm/test — test-only, no persistence.
  router.post('/llm/test', requireConfigWrite, async (req: Request, res: Response) => {
    const cfg = req.body as LlmConfigWire;
    if (!cfg?.provider || !cfg?.model) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'provider and model are required' },
      });
      return;
    }
    const result = await llmService.testConnection(cfg);
    res.status(result.ok ? 200 : 400).json(result);
  });

  // POST /api/setup/llm/models — list available models.
  router.post('/llm/models', requireConfigWrite, async (req: Request, res: Response) => {
    const cfg = req.body as { provider: string; apiKey?: string; baseUrl?: string };
    if (!cfg?.provider) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'provider is required' },
      });
      return;
    }
    let models;
    let errorMessage: string | undefined;
    try {
      ({ models, errorMessage } = await llmService.fetchModels(cfg));
    } catch (err) {
      if (err instanceof SetupLlmServiceError && err.kind === 'invalid_url') {
        res.status(400).json({
          error: { code: 'INVALID_URL', message: err.message },
        });
        return;
      }
      throw err;
    }
    if (models.length === 0) {
      res.json({
        models,
        warning: errorMessage
          ? `Could not fetch models — ${errorMessage}. Check your API key / URL, or continue with the default list.`
          : `Could not fetch models from ${cfg.provider}. Check your API key / URL, or continue with the default list.`,
      });
      return;
    }
    res.json({ models });
  });

  // Save endpoints for datasources / notifications / llm moved to
  // `/api/datasources`, `/api/system/notifications`, and `/api/system/llm`
  // respectively in T2.5. All three are bootstrap-aware so the wizard
  // can still hit them pre-first-admin.

  // POST /api/setup/reset — dev utility. Clears LLM + all datasources +
  // notifications. Leaves `bootstrapped_at` in place so the gate doesn't
  // reopen. Post-bootstrap this requires `instance.config:write` (Admin+);
  // pre-bootstrap the outer `requireSetupAccess` middleware lets the wizard
  // through unauthenticated.
  router.post(
    '/reset',
    requirePermission(() => ac.eval(ACTIONS.InstanceConfigWrite)),
    async (_req: Request, res: Response) => {
      await setupConfig.clearLlm({ userId: null });
      const datasources = await setupConfig.listDatasources();
      for (const ds of datasources) {
        await setupConfig.deleteDatasource(ds.id, { userId: null });
      }
      const channels = await setupConfig.listNotificationChannels();
      for (const c of channels) {
        await setupConfig.deleteNotificationChannel(c.id, { userId: null });
      }
      res.json({ ok: true });
    },
  );

  return router;
}
