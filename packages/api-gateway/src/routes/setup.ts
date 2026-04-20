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
import { DEFAULT_LLM_MODEL, ac, ACTIONS } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type {
  IOrgRepository,
  IOrgUserRepository,
  IUserRepository,
  LlmConfigWire,
  NotificationsWire,
} from '@agentic-obs/common';
import { AuditAction } from '@agentic-obs/common';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { ensureSafeUrl } from '../utils/url-validator.js';
import { createRateLimiter, loginRateLimiter } from '../middleware/rate-limiter.js';
import { bootstrapAware } from '../middleware/bootstrap-aware.js';
import { hashPassword, passwordMinLength } from '../auth/local-provider.js';
import type { SessionService } from '../auth/session-service.js';
import { SESSION_COOKIE_NAME } from '../auth/session-service.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  type ModelInfo,
} from '@agentic-obs/llm-gateway';

const log = createLogger('setup');

// Wire shapes `LlmConfigWire` and `NotificationsWire` are owned by
// `@agentic-obs/common/models/wire-config` (T3.3) so the web frontend
// and the api-gateway agree on the HTTP request/response format.

// -- LLM Connectivity Test --------------------------------------------

function resolveToken(cfg: LlmConfigWire): string | null {
  return cfg.apiKey ?? null;
}

const PROVIDER_PROBE_TIMEOUT_MS = 15_000;

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return `Provider did not respond within ${Math.round(PROVIDER_PROBE_TIMEOUT_MS / 1000)}s`;
    }
    return err.message;
  }
  return 'Connection failed';
}

async function guardProviderUrl(
  finalUrl: string,
  userSuppliedBase: string | undefined,
): Promise<void> {
  if (!userSuppliedBase) return;
  await ensureSafeUrl(finalUrl);
}

async function testLlmConnection(cfg: LlmConfigWire): Promise<{ ok: boolean; message: string }> {
  try {
    if (cfg.provider === 'corporate-gateway') {
      const token = resolveToken(cfg);
      if (!token) return { ok: false, message: 'Bearer token or API key is required' };
      const baseUrl = cfg.baseUrl;
      if (!baseUrl) return { ok: false, message: 'Gateway base URL is required' };

      const target = `${baseUrl}/v1/messages`;
      await guardProviderUrl(target, baseUrl);

      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.authType === 'bearer'
            ? { Authorization: `Bearer ${token}` }
            : { 'api-key': token }),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model || DEFAULT_LLM_MODEL,
          messages: [{ role: 'user', content: 'Say "ok".' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });

      if (res.ok) return { ok: true, message: 'Connected via corporate gateway' };
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'anthropic') {
      const key = cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
      if (!key) return { ok: false, message: 'API key is required' };
      const baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
      const target = `${baseUrl}/v1/models`;
      await guardProviderUrl(target, cfg.baseUrl);
      const res = await fetch(target, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, message: 'Connected successfully' };
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'openai' || cfg.provider === 'deepseek') {
      const key = cfg.apiKey ?? '';
      if (!key) return { ok: false, message: 'API key is required' };
      const base =
        cfg.provider === 'deepseek'
          ? cfg.baseUrl || 'https://api.deepseek.com/v1'
          : cfg.baseUrl || 'https://api.openai.com/v1';
      const target = `${base}/models`;
      await guardProviderUrl(target, cfg.baseUrl);
      const res = await fetch(target, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, message: 'Connected successfully' };
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'ollama') {
      const base = cfg.baseUrl || 'http://localhost:11434';
      const target = `${base}/api/tags`;
      await guardProviderUrl(target, cfg.baseUrl);
      const res = await fetch(target, {
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, message: 'Connected successfully' };
      return { ok: false, message: `HTTP ${res.status}` };
    }

    if (cfg.provider === 'gemini') {
      const key = cfg.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
      if (!key) return { ok: false, message: 'API key is required' };
      const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
      const target = `${base}/v1beta/models?key=${key}`;
      await guardProviderUrl(target, cfg.baseUrl);
      const res = await fetch(target, {
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, message: 'Connected successfully' };
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'azure-openai') {
      if (!cfg.apiKey || !cfg.baseUrl)
        return { ok: false, message: 'API key and endpoint URL are required' };
      return { ok: true, message: 'Configuration looks valid (live test not performed)' };
    }

    if (cfg.provider === 'aws-bedrock') {
      if (!cfg.region) return { ok: false, message: 'AWS region is required' };
      return { ok: true, message: 'Configuration looks valid (live test not performed)' };
    }

    return { ok: false, message: 'Unknown provider' };
  } catch (err) {
    log.warn(
      { err, provider: cfg.provider, baseUrl: cfg.baseUrl },
      'LLM test-connection failed',
    );
    return { ok: false, message: describeFetchError(err) };
  }
}

// -- Model Listing ----------------------------------------------------

async function fetchModels(cfg: {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  try {
    switch (cfg.provider) {
      case 'anthropic': {
        const provider = new AnthropicProvider({
          apiKey: cfg.apiKey ?? '',
          baseUrl: cfg.baseUrl,
        });
        return await provider.listModels();
      }
      case 'openai': {
        const provider = new OpenAIProvider({
          apiKey: cfg.apiKey ?? '',
          baseUrl: cfg.baseUrl,
        });
        return await provider.listModels();
      }
      case 'deepseek': {
        return await fetchDeepseekModels(cfg.apiKey ?? '', cfg.baseUrl);
      }
      case 'gemini': {
        const provider = new GeminiProvider({
          apiKey: cfg.apiKey ?? '',
          baseUrl: cfg.baseUrl,
        });
        return await provider.listModels();
      }
      case 'ollama': {
        const provider = new OllamaProvider({ baseUrl: cfg.baseUrl });
        return await provider.listModels();
      }
      default:
        return [];
    }
  } catch (err) {
    log.warn({ err, provider: cfg.provider, baseUrl: cfg.baseUrl }, 'fetchModels failed');
    return [];
  }
}

function buildModelsProbeUrl(provider: string, baseUrl: string): string | null {
  switch (provider) {
    case 'anthropic':
      return `${baseUrl}/v1/models`;
    case 'openai':
    case 'deepseek':
      return `${baseUrl}/models`;
    case 'gemini':
      return `${baseUrl}/v1beta/models`;
    case 'ollama':
      return `${baseUrl}/api/tags`;
    default:
      return null;
  }
}

async function fetchDeepseekModels(apiKey: string, baseUrl?: string): Promise<ModelInfo[]> {
  const base = baseUrl || 'https://api.deepseek.com/v1';
  const target = `${base}/models`;
  try {
    if (baseUrl) await ensureSafeUrl(target);
    const res = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ status: res.status, base }, 'DeepSeek /models returned non-OK');
      return [];
    }
    const body = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    const data = body.data ?? [];
    return data
      .map((m) => m.id)
      .sort()
      .map((id) => ({ id, name: id, provider: 'deepseek' }));
  } catch (err) {
    log.warn({ err, base }, 'DeepSeek /models fetch failed');
    return [];
  }
}

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
    if (await setupConfig.isBootstrapped()) {
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'admin already exists' },
      });
      return;
    }
    const body = (req.body ?? {}) as {
      email?: string;
      name?: string;
      login?: string;
      password?: string;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const login =
      typeof body.login === 'string' && body.login.trim() !== ''
        ? body.login.trim()
        : email.split('@')[0] ?? '';
    const password = typeof body.password === 'string' ? body.password : '';
    const atIdx = email.indexOf('@');
    if (atIdx < 1 || atIdx === email.length - 1 || !email.slice(atIdx + 1).includes('.')) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'valid email required' },
      });
      return;
    }
    if (!name) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'name required' },
      });
      return;
    }
    if (!login) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'login required' },
      });
      return;
    }
    const env = process.env;
    const minLen = passwordMinLength(env);
    if (password.length < minLen) {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: `password must be at least ${minLen} characters`,
        },
      });
      return;
    }
    const orgId = deps.defaultOrgId ?? 'org_main';
    const existingOrg = await deps.orgs.findById(orgId);
    if (!existingOrg) {
      await deps.orgs.create({ id: orgId, name: 'Main Org' });
    }
    const hashed = await hashPassword(password);
    const user = await deps.users.create({
      email,
      name,
      login,
      password: hashed,
      orgId,
      isAdmin: true,
      emailVerified: true,
    });
    await deps.orgUsers.create({ orgId, userId: user.id, role: 'Admin' });

    // Close the bootstrap gate BEFORE issuing the session. If any step after
    // this point fails we'd rather re-run with the admin present than
    // accidentally leave the gate open.
    await setupConfig.markBootstrapped();

    const ua = typeof req.headers['user-agent'] === 'string'
      ? (req.headers['user-agent'] as string)
      : '';
    const ip = (req.ip || req.socket?.remoteAddress || '') as string;
    const session = await deps.sessions.create(user.id, ua, ip);
    res.setHeader(
      'Set-Cookie',
      [
        `${SESSION_COOKIE_NAME}=${session.token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        process.env['NODE_ENV'] === 'production' ? 'Secure' : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
    void deps.audit.log({
      action: AuditAction.UserCreated,
      actorType: 'system',
      actorId: 'setup-wizard',
      targetType: 'user',
      targetId: user.id,
      outcome: 'success',
      metadata: { bootstrap: true, orgId },
    });
    res.status(201).json({ userId: user.id, orgId });
  });

  router.use(requireSetupAccess);

  // GET /api/setup/config — returns current config (secrets masked).
  router.get('/config', async (_req: Request, res: Response) => {
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
  router.post('/llm/test', async (req: Request, res: Response) => {
    const cfg = req.body as LlmConfigWire;
    if (!cfg?.provider || !cfg?.model) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'provider and model are required' },
      });
      return;
    }
    const result = await testLlmConnection(cfg);
    res.status(result.ok ? 200 : 400).json(result);
  });

  // POST /api/setup/llm/models — list available models.
  router.post('/llm/models', async (req: Request, res: Response) => {
    const cfg = req.body as { provider: string; apiKey?: string; baseUrl?: string };
    if (!cfg?.provider) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'provider is required' },
      });
      return;
    }
    if (cfg.baseUrl) {
      const probeUrl = buildModelsProbeUrl(cfg.provider, cfg.baseUrl);
      if (probeUrl) {
        try {
          await ensureSafeUrl(probeUrl);
        } catch (err) {
          res.status(400).json({
            error: {
              code: 'INVALID_URL',
              message: err instanceof Error ? err.message : 'Invalid URL',
            },
          });
          return;
        }
      }
    }
    const models = await fetchModels(cfg);
    if (models.length === 0) {
      res.json({
        models,
        warning: `Could not fetch models from ${cfg.provider}. Check your API key / URL, or continue with the default list.`,
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
