import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_LLM_MODEL } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type {
  IOrgRepository,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
// Auth for /api/setup is bootstrap-style: unauthenticated when no users yet.
// T4+ will re-introduce the full auth middleware here.
import { ensureSafeUrl } from '../utils/url-validator.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { hashPassword, passwordMinLength } from '../auth/local-provider.js';
import type { SessionService } from '../auth/session-service.js';
import { SESSION_COOKIE_NAME } from '../auth/session-service.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import { AuditAction } from '@agentic-obs/common';

const log = createLogger('setup');
import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  type ModelInfo,
} from '@agentic-obs/llm-gateway';

// -- Types

export interface LlmConfig {
  provider: 'anthropic' | 'openai' | 'deepseek' | 'azure-openai' | 'aws-bedrock' | 'ollama' | 'gemini' | 'corporate-gateway';
  apiKey?: string;
  model: string;
  baseUrl?: string;
  region?: string; // For AWS Bedrock
  /** Auth type: "api-key" (default) or "bearer" (for corporate gateways with Okta/SSO) */
  authType?: 'api-key' | 'bearer';
}

export interface DatasourceConfig {
  id: string;
  type: 'loki' | 'elasticsearch' | 'clickhouse' | 'tempo' | 'jaeger' | 'otel' | 'prometheus' | 'victoria-metrics';
  name: string;
  url: string;
  environment?: string; // e.g. "prod" "staging" "dev" "test" "build"
  cluster?: string; // e.g. "eu-cluster", "us-east"
  label?: string; // Display name e.g. "Prod - Cluster A"
  apiKey?: string;
  username?: string;
  password?: string;
  isDefault?: boolean; // true - preferred datasource when none specified
}

export interface NotificationConfig {
  slack?: { webhookUrl: string };
  pagerduty?: { integrationKey: string };
  email?: { host: string; port: number; username: string; password: string; from: string };
}

export interface SetupConfig {
  configured: boolean;
  llm?: LlmConfig;
  datasources: DatasourceConfig[];
  notifications?: NotificationConfig;
  completedAt?: string;
}

// -- Persistence

const CONFIG_DIR = join(homedir(), '.agentic-obs');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

let inMemoryConfig: SetupConfig = {
  configured: false,
  datasources: [],
};

function normalizeLlmConfig(config?: LlmConfig | null): LlmConfig | undefined {
  if (!config) return undefined;
  return {
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    region: config.region,
    authType: config.authType,
  };
}

function normalizeSetupConfig(config: SetupConfig): SetupConfig {
  return {
    ...config,
    llm: normalizeLlmConfig(config.llm),
  };
}

async function loadConfig(): Promise<SetupConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    return normalizeSetupConfig(JSON.parse(raw) as SetupConfig);
  } catch (err) {
    log.debug({ err }, 'failed to load config file, using in-memory config');
    return inMemoryConfig;
  }
}

async function saveConfig(config: SetupConfig): Promise<void> {
  inMemoryConfig = normalizeSetupConfig(config);
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(inMemoryConfig, null, 2), 'utf-8');
  } catch (err) {
    log.debug({ err }, 'failed to persist config file (best-effort)');
  }
}

// -- LLM Connectivity Test

function resolveToken(cfg: LlmConfig): string | null {
  return cfg.apiKey ?? null;
}

async function testLlmConnection(cfg: LlmConfig): Promise<{ ok: boolean; message: string }> {
  try {
    // SSRF protection: validate baseUrl if provided
    if (cfg.baseUrl) {
      await ensureSafeUrl(cfg.baseUrl);
    }

    if (cfg.provider === 'corporate-gateway') {
      const token = resolveToken(cfg);
      if (!token)
        return { ok: false, message: 'Bearer token or API key is required' };
      const baseUrl = cfg.baseUrl;
      if (!baseUrl)
        return { ok: false, message: 'Gateway base URL is required' };

      // Test with a minimal API call
      const res = await fetch(`${baseUrl}/v1/messages`, {
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
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok)
        return { ok: true, message: 'Connected via corporate gateway' };
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'anthropic') {
      const key = cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
      if (!key)
        return { ok: false, message: 'API key is required' };
      const baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
      const res = await fetch(`${baseUrl}/v1/models`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      if (res.ok)
        return { ok: true, message: 'Connected successfully' };
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'openai' || cfg.provider === 'deepseek') {
      const key = cfg.apiKey ?? '';
      if (!key)
        return { ok: false, message: 'API key is required' };
      const base = cfg.provider === 'deepseek'
        ? (cfg.baseUrl || 'https://api.deepseek.com')
        : (cfg.baseUrl || 'https://api.openai.com/v1');
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok)
        return { ok: true, message: 'Connected successfully' };
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'ollama') {
      const base = cfg.baseUrl || 'http://localhost:11434';
      const res = await fetch(`${base}/api/tags`);
      if (res.ok)
        return { ok: true, message: 'Connected successfully' };
      return { ok: false, message: `HTTP ${res.status}` };
    }

    if (cfg.provider === 'gemini') {
      const key = cfg.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
      if (!key)
        return { ok: false, message: 'API key is required' };
      const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
      const res = await fetch(`${base}/v1beta/models?key=${key}`);
      if (res.ok)
        return { ok: true, message: 'Connected successfully' };
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
    }

    if (cfg.provider === 'azure-openai') {
      if (!cfg.apiKey || !cfg.baseUrl)
        return { ok: false, message: 'API key and endpoint URL are required' };
      return { ok: true, message: 'Configuration looks valid (live test not performed)' };
    }

    if (cfg.provider === 'aws-bedrock') {
      if (!cfg.region)
        return { ok: false, message: 'AWS region is required' };
      return { ok: true, message: 'Configuration looks valid (live test not performed)' };
    }

    return { ok: false, message: 'Unknown provider' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// -- Datasource Connectivity Test

import { testDatasourceConnection } from '../utils/datasource.js';

// -- Model Listing

async function fetchModels(cfg: { provider: string; apiKey?: string; baseUrl?: string }): Promise<ModelInfo[]> {
  try {
    switch (cfg.provider) {
      case 'anthropic': {
        const provider = new AnthropicProvider({ apiKey: cfg.apiKey ?? '' , baseUrl: cfg.baseUrl });
        return await provider.listModels();
      }
      case 'openai':
      case 'deepseek': {
        const base = cfg.provider === 'deepseek'
          ? (cfg.baseUrl || 'https://api.deepseek.com')
          : cfg.baseUrl;
        const provider = new OpenAIProvider({ apiKey: cfg.apiKey ?? '', baseUrl: base });
        return await provider.listModels();
      }
      case 'gemini': {
        const provider = new GeminiProvider({ apiKey: cfg.apiKey ?? '', baseUrl: cfg.baseUrl });
        return await provider.listModels();
      }
      case 'ollama': {
        const provider = new OllamaProvider({ baseUrl: cfg.baseUrl });
        return await provider.listModels();
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// -- Public access

/** Returns the current in-memory setup config (LLM, datasources, etc.). */
export function getSetupConfig(): SetupConfig {
  return inMemoryConfig;
}

/** Updates only the datasources array in the current config and persists. */
export async function updateDatasources(datasources: DatasourceConfig[]): Promise<void> {
  inMemoryConfig = { ...inMemoryConfig, datasources };
  await saveConfig(inMemoryConfig);
}

/** Ensures persisted config is loaded into memory. Safe to call multiple times. */
let configLoadPromise: Promise<void> | undefined;
export function ensureConfigLoaded(): Promise<void> {
  if (!configLoadPromise) {
    configLoadPromise = loadConfig().then((cfg) => {
      inMemoryConfig = cfg;
    });
  }
  return configLoadPromise;
}

// Setter wired at boot by server.ts so the setup route can reach the real
// UserRepository without pulling a circular import. When unset (tests), we
// fall back to "always allow" which is safe because test DBs don't persist.
let hasAnyUser: () => Promise<boolean> = async () => false;

export function setBootstrapHasUsers(fn: () => Promise<boolean>): void {
  hasAnyUser = fn;
}

/**
 * Wave 6 / T9.4 — first-admin bootstrap endpoint dependencies. Wired at boot
 * by `server.ts`. When unset, `POST /api/setup/admin` returns 503 so we never
 * accidentally accept an admin creation request without a backing DB.
 */
export interface SetupAdminDeps {
  users: IUserRepository;
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
  sessions: SessionService;
  audit: AuditWriter;
  defaultOrgId?: string;
}
let setupAdminDeps: SetupAdminDeps | null = null;

export function setSetupAdminDeps(deps: SetupAdminDeps): void {
  setupAdminDeps = deps;
}

async function allowBootstrapSetup(): Promise<boolean> {
  // Allow unauthenticated setup access when there is no way to authenticate:
  // either the system was never configured, or no users exist yet.
  if (!inMemoryConfig.configured) return true;
  return !(await hasAnyUser());
}

function requireSetupAccess(req: Request, res: Response, next: NextFunction): void {
  void allowBootstrapSetup().then((bootstrap) => {
    if (bootstrap) {
      next();
      return;
    }
    res.status(401).json({ message: 'authentication required' });
  });
}

// -- Rate limiter for setup endpoints (strict: 5 req/min per IP)

const setupRateLimiter = createRateLimiter({
  windowMs: 60_000, // 1 minute
  max: 20,
});

// -- Router

export function createSetupRouter(): Router {
  const router = Router();

  // Apply strict rate limiting before any setup route (including bootstrap)
  router.use(setupRateLimiter);

  // Load persisted config on startup
  void ensureConfigLoaded().catch((err) => {
    log.error({ err }, 'failed to load config');
  });

  // GET /api/setup/status — reports wizard-completion flags. `hasAdmin` drives
  // the T9.4 wizard's skip logic for upgraded installs.
  router.get('/status', async (_req: Request, res: Response) => {
    let hasAdmin = false;
    try {
      hasAdmin = await hasAnyUser();
    } catch {
      hasAdmin = false;
    }
    res.json({
      configured: inMemoryConfig.configured,
      hasAdmin,
      hasLLM: !!inMemoryConfig.llm,
      datasourceCount: inMemoryConfig.datasources.length,
      hasNotifications: !!(
        inMemoryConfig.notifications?.slack
        || inMemoryConfig.notifications?.pagerduty
        || inMemoryConfig.notifications?.email
      ),
    });
  });

  // POST /api/setup/admin — first-admin bootstrap. Public but one-shot:
  // returns 409 once any user exists. On success creates the user, seeds
  // org_user(role=Admin), issues a session cookie, and returns the new ids.
  router.post('/admin', async (req: Request, res: Response) => {
    if (!setupAdminDeps) {
      res.status(503).json({ message: 'auth subsystem not ready' });
      return;
    }
    const deps = setupAdminDeps;
    const env = process.env;
    // One-shot: if any user already exists, this endpoint locks down. The
    // setup flow then expects the caller to switch to the login page.
    const already = await hasAnyUser().catch(() => false);
    if (already) {
      res.status(409).json({ message: 'admin already exists' });
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
    const login = typeof body.login === 'string' && body.login.trim() !== ''
      ? body.login.trim()
      : email.split('@')[0] ?? '';
    const password = typeof body.password === 'string' ? body.password : '';
    const atIdx = email.indexOf('@');
    if (atIdx < 1 || atIdx === email.length - 1 || !email.slice(atIdx + 1).includes('.')) {
      res.status(400).json({ message: 'valid email required' });
      return;
    }
    if (!name) {
      res.status(400).json({ message: 'name required' });
      return;
    }
    if (!login) {
      res.status(400).json({ message: 'login required' });
      return;
    }
    const minLen = passwordMinLength(env);
    if (password.length < minLen) {
      res.status(400).json({
        message: `password must be at least ${minLen} characters`,
      });
      return;
    }
    const orgId = deps.defaultOrgId ?? 'org_main';
    // Ensure the default org exists (migration 001 usually inserts it; be
    // resilient in case tests bypass migrations).
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

    // Issue session cookie so the browser is logged in for the rest of the
    // wizard without a separate /login round-trip.
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

  // GET /api/setup/config — returns current config (API keys masked)
  router.get('/config', (_req: Request, res: Response) => {
    const cfg = { ...inMemoryConfig };
    // Mask sensitive fields
    if (cfg.llm) {
      cfg.llm = {
        ...cfg.llm,
        apiKey: cfg.llm.apiKey ? '••••••' + cfg.llm.apiKey.slice(-4) : undefined,
      };
    }
    cfg.datasources = cfg.datasources.map((ds) => ({
      ...ds,
      apiKey: ds.apiKey ? '••••••' + ds.apiKey.slice(-4) : undefined,
      password: ds.password ? '••••••' : undefined,
    }));
    res.json(cfg);
  });

  // POST /api/setup/llm
  router.post('/llm', async (req: Request, res: Response) => {
    const body = req.body as { config: LlmConfig; test?: boolean };
    const cfg = body.config;

    if (!cfg?.provider || !cfg?.model) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'provider and model are required' } });
      return;
    }

    if (!cfg.apiKey && cfg.provider !== 'ollama' && cfg.provider !== 'aws-bedrock') {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'apiKey is required for this provider' } });
      return;
    }

    if (body.test) {
      const result = await testLlmConnection(cfg);
      if (!result.ok) {
        res.status(400).json({ error: { code: 'CONNECTION_FAILED', message: result.message } });
        return;
      }
      res.json({ ok: true, message: result.message });
      return;
    }

    inMemoryConfig = { ...inMemoryConfig, llm: normalizeLlmConfig(cfg) };
    await saveConfig(inMemoryConfig);
    res.json({ ok: true });
  });

  // POST /api/setup/llm/test
  router.post('/llm/test', async (req: Request, res: Response) => {
    const cfg = req.body as LlmConfig;
    if (!cfg?.provider || !cfg?.model) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'provider and model are required' } });
      return;
    }
    const result = await testLlmConnection(cfg);
    res.status(result.ok ? 200 : 400).json(result);
  });

  // POST /api/setup/llm/models — fetch available models from provider
  router.post('/llm/models', async (req: Request, res: Response) => {
    const cfg = req.body as { provider: string; apiKey?: string; baseUrl?: string };
    if (!cfg?.provider) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'provider is required' } });
      return;
    }
    const models = await fetchModels(cfg);
    res.json({ models });
  });

  // POST /api/setup/datasource
  router.post('/datasource', async (req: Request, res: Response) => {
    const body = req.body as { datasource: DatasourceConfig; test?: boolean };
    const ds = body.datasource;

    if (!ds?.type || !ds?.url) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'type and url are required' } });
      return;
    }

    if (body.test) {
      const result = await testDatasourceConnection(ds);
      if (!result.ok) {
        res.status(400).json({ error: { code: 'CONNECTION_FAILED', message: result.message } });
        return;
      }
      res.json({ ok: true, message: result.message });
      return;
    }

    const existing = inMemoryConfig.datasources.findIndex((d) => d.id === ds.id);
    const datasources = [...inMemoryConfig.datasources];
    if (existing >= 0)
      datasources[existing] = ds;
    else
      datasources.push(ds);

    inMemoryConfig = { ...inMemoryConfig, datasources };
    await saveConfig(inMemoryConfig);
    res.json({ ok: true, datasource: ds });
  });

  // DELETE /api/setup/datasource/:id
  router.delete('/datasource/:id', async (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    inMemoryConfig = {
      ...inMemoryConfig,
      datasources: inMemoryConfig.datasources.filter((d) => d.id !== id),
    };
    await saveConfig(inMemoryConfig);
    res.json({ ok: true });
  });

  // POST /api/setup/notifications
  router.post('/notifications', async (req: Request, res: Response) => {
    const notifications = req.body as NotificationConfig;
    inMemoryConfig = { ...inMemoryConfig, notifications };
    await saveConfig(inMemoryConfig);
    res.json({ ok: true });
  });

  // POST /api/setup/complete
  router.post('/complete', async (_req: Request, res: Response) => {
    inMemoryConfig = {
      ...inMemoryConfig,
      configured: true,
      completedAt: new Date().toISOString(),
    };
    await saveConfig(inMemoryConfig);
    res.json({ ok: true, completedAt: inMemoryConfig.completedAt });
  });

  // POST /api/setup/reset (dev utility)
  router.post('/reset', async (_req: Request, res: Response) => {
    inMemoryConfig = { configured: false, datasources: [] };
    await saveConfig(inMemoryConfig);
    res.json({ ok: true });
  });

  return router;
}
