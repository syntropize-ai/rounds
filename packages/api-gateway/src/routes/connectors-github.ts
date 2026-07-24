/**
 * GitHub App registration + install flow.
 *
 *   GET  /api/connectors/github/registration-status  → { registered, slug?, registeredAt? }
 *   GET  /api/connectors/github/manifest             → { manifestUrl, state, manifest }  (auth)
 *   GET  /api/connectors/github/manifest-callback    ← GitHub redirect after manifest creation (unauth)
 *   POST /api/connectors/github/unregister           → { ok }                              (auth)
 *   GET  /api/connectors/github/install-url          → { url }                             (auth)
 *   GET  /api/connectors/github/callback             ← GitHub redirect after install        (unauth)
 *
 * The `/manifest-callback` and `/callback` routes are mounted as
 * unauthenticated; everything else requires a session. See domain-routes.ts.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Connector, NewConnector } from '@agentic-obs/common';
import type {
  IGithubAppConfigRepository,
  NewGithubAppConfig,
} from '@agentic-obs/data-layer';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  buildInstallUrl,
  convertAppManifest,
  exchangeInstallationForToken,
  listGithubAppInstallations,
} from '../services/github-app.js';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('connectors-github');

const STATE_TTL_MS = 5 * 60 * 1000;

interface StateEntry {
  orgId: string;
  userId: string;
  expiresAt: number;
}

export interface ConnectorsGithubDeps {
  createConnector: (input: NewConnector) => Promise<Connector>;
  upsertSecret: (input: { connectorId: string; ciphertext: Uint8Array }) => Promise<unknown>;
  githubAppConfig: IGithubAppConfigRepository;
  /** Base URL operator uses to reach this instance. Used for redirect/hook URLs. */
  appBaseUrl: string;
  /** Test seam — defaults to the real GitHub installation token exchange. */
  exchange?: typeof exchangeInstallationForToken;
  /** Test seam — defaults to the real GitHub installations list call. */
  listInstallations?: typeof listGithubAppInstallations;
  /** Test seam — defaults to the real GitHub manifest conversion call. */
  convertManifest?: typeof convertAppManifest;
}

export function createConnectorsGithubRouter(deps: ConnectorsGithubDeps): Router {
  const router = Router();
  const exchange = deps.exchange ?? exchangeInstallationForToken;
  const listInstallations = deps.listInstallations ?? listGithubAppInstallations;
  const convertManifest = deps.convertManifest ?? convertAppManifest;
  const states = new Map<string, StateEntry>();
  const fallbackBaseUrl = deps.appBaseUrl.replace(/\/+$/, '');

  /**
   * Resolve the deployment's externally-reachable base URL.
   * Prefers explicit `ROUNDS_BASE_URL` / `APP_BASE_URL` env via `deps.appBaseUrl`;
   * if unset, falls back to the incoming request's `X-Forwarded-Proto` /
   * `Host` headers so localhost dev works without env config.
   */
  function resolveSettingsUrl(req: Request): string {
    return `${resolveBaseUrl(req)}/settings`;
  }
  function resolveBaseUrl(req: Request): string {
    if (fallbackBaseUrl) return fallbackBaseUrl;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)
      ?? (req.protocol || 'http');
    const host = (req.headers['x-forwarded-host'] as string | undefined)
      ?? (req.headers['host'] as string | undefined)
      ?? 'localhost:3000';
    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  function stashState(orgId: string, userId: string): string {
    sweepExpired(states);
    const state = randomBytes(24).toString('hex');
    states.set(state, { orgId, userId, expiresAt: Date.now() + STATE_TTL_MS });
    return state;
  }

  function consumeState(state: string): StateEntry | null {
    sweepExpired(states);
    const entry = states.get(state);
    if (!entry) return null;
    states.delete(state);
    return entry;
  }

  router.get('/registration-status', async (req, res) => {
    const orgId = (req as AuthenticatedRequest).auth?.orgId;
    if (!orgId) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'org context is required' } });
      return;
    }
    const cfg = await deps.githubAppConfig.get(orgId);
    if (!cfg) {
      res.json({ registered: false });
      return;
    }
    res.json({
      registered: true,
      slug: cfg.slug,
      appId: cfg.appId,
      registeredAt: cfg.registeredAt,
    });
  });

  router.get('/manifest', (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    const orgId = auth?.orgId;
    const userId = auth?.userId;
    if (!orgId || !userId) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'org context is required' } });
      return;
    }
    const customName = strParam(req.query['name']);
    const name = customName ?? 'Rounds';
    const state = stashState(orgId, userId);
    const baseUrl = resolveBaseUrl(req);
    // GitHub rejects manifests whose hook_attributes.url is not publicly
    // reachable — localhost / 127.0.0.1 / .local / .internal hosts all fail
    // their probe. For dev installs we omit hook_attributes entirely (the
    // App is created without webhooks; can be added later via the GitHub
    // App settings page when deployed to a real domain).
    const hostname = (() => {
      try { return new URL(baseUrl).hostname; } catch { return ''; }
    })();
    const isPubliclyReachable = !!hostname
      && hostname !== 'localhost'
      && hostname !== '127.0.0.1'
      && hostname !== '0.0.0.0'
      && !hostname.endsWith('.local')
      && !hostname.endsWith('.internal')
      && !hostname.endsWith('.lan')
      && !/^192\.168\./.test(hostname)
      && !/^10\./.test(hostname)
      && !/^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    interface AppManifest {
      name: string;
      url: string;
      redirect_url: string;          // after App is CREATED via manifest
      callback_urls: string[];       // after OAuth user authorization
      setup_url: string;             // after a USER INSTALLS the App on an org/repos
      setup_on_update: boolean;
      public: boolean;
      default_permissions: Record<string, string>;
      default_events: string[];
      hook_attributes?: { url: string; active: boolean };
    }
    const manifest: AppManifest = {
      name,
      url: baseUrl,
      redirect_url: `${baseUrl}/api/connectors/github/manifest-callback`,
      // After install, GitHub redirects here with ?installation_id=...&setup_action=install&state=...
      // We reuse the OAuth callback handler — it already creates a connector
      // from the installation_id.
      setup_url: `${baseUrl}/api/connectors/github/callback`,
      setup_on_update: true,
      callback_urls: [`${baseUrl}/api/connectors/github/callback`],
      public: false,
      default_permissions: {
        contents: 'read',
        pull_requests: 'write',
        issues: 'read',
        metadata: 'read',
      },
      default_events: [],
    };
    if (isPubliclyReachable) {
      manifest.hook_attributes = {
        url: `${baseUrl}/api/webhooks/github`,
        active: false,
      };
    }
    res.json({
      manifestUrl: 'https://github.com/settings/apps/new',
      state,
      manifest: JSON.stringify(manifest),
    });
  });

  router.get('/manifest-callback', async (req: Request, res: Response) => {
    const code = strParam(req.query['code']);
    const state = strParam(req.query['state']);
    if (!code || !state) {
      return redirectErr(res, resolveSettingsUrl(req), 'missing code or state');
    }
    const entry = consumeState(state);
    if (!entry) {
      return redirectErr(res, resolveSettingsUrl(req), 'invalid-state');
    }
    try {
      const conv = await convertManifest(code);
      const toInsert: NewGithubAppConfig = {
        orgId: entry.orgId,
        appId: conv.appId,
        slug: conv.slug,
        clientId: conv.clientId,
        clientSecret: conv.clientSecret,
        privateKey: conv.privateKey,
        webhookSecret: conv.webhookSecret,
        registeredBy: entry.userId,
      };
      await deps.githubAppConfig.insert(toInsert);
      res.redirect(`${resolveSettingsUrl(req)}?github=registered`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'github manifest-callback failed');
      redirectErr(res, resolveSettingsUrl(req), message);
    }
  });

  router.post('/unregister', async (req, res) => {
    const orgId = (req as AuthenticatedRequest).auth?.orgId;
    if (!orgId) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'org context is required' } });
      return;
    }
    const ok = await deps.githubAppConfig.delete(orgId);
    res.json({ ok });
  });

  router.get('/install-url', async (req: Request, res: Response) => {
    const orgId = (req as AuthenticatedRequest).auth?.orgId;
    if (!orgId) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'org context is required' } });
      return;
    }
    const cfg = await deps.githubAppConfig.get(orgId);
    if (!cfg) {
      res.status(503).json({
        ok: false,
        message: 'GitHub App not registered. Call /api/connectors/github/manifest first.',
        error: { code: 'NOT_REGISTERED', message: 'GitHub App not registered.' },
      });
      return;
    }
    res.json({ url: buildInstallUrl(cfg, orgId) });
  });

  router.post('/sync-installations', async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    const orgId = auth?.orgId;
    const userId = auth?.userId ?? 'system:github-sync';
    if (!orgId) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'org context is required' } });
      return;
    }
    const cfg = await deps.githubAppConfig.get(orgId);
    if (!cfg) {
      res.status(503).json({
        ok: false,
        message: 'GitHub App not registered. Call /api/connectors/github/manifest first.',
        error: { code: 'NOT_REGISTERED', message: 'GitHub App not registered.' },
      });
      return;
    }

    try {
      const installations = await listInstallations(cfg);
      const created: Array<{ connectorId: string; owner: string; installationId: string }> = [];
      const refreshed: Array<{ connectorId: string; owner: string; installationId: string }> = [];
      const errors: Array<{ installationId: string; owner: string; message: string }> = [];
      for (const installation of installations) {
        const connectorId = `github-${installation.id}`;
        try {
          const { token, expiresAt, owner } = await exchange(cfg, installation.id);
          const connector = await deps.createConnector({
            id: connectorId,
            orgId,
            type: 'github',
            name: `${owner} (GitHub)`,
            config: { owner, installationId: installation.id },
            status: 'active',
            createdBy: userId,
          });
          await deps.upsertSecret({
            connectorId: connector.id,
            ciphertext: new TextEncoder().encode(JSON.stringify({ token, expiresAt })),
          });
          created.push({ connectorId: connector.id, owner, installationId: installation.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/already exists|constraint|unique|conflict/i.test(msg)) {
            try {
              const { token, expiresAt, owner } = await exchange(cfg, installation.id);
              await deps.upsertSecret({
                connectorId,
                ciphertext: new TextEncoder().encode(JSON.stringify({ token, expiresAt })),
              });
              refreshed.push({ connectorId, owner, installationId: installation.id });
              continue;
            } catch (refreshErr) {
              errors.push({
                installationId: installation.id,
                owner: installation.owner,
                message: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
              });
              continue;
            }
          }
          errors.push({ installationId: installation.id, owner: installation.owner, message: msg });
        }
      }
      res.json({ ok: errors.length === 0, created, refreshed, errors });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'github sync-installations failed');
      res.status(502).json({ ok: false, error: { code: 'GITHUB_SYNC_FAILED', message } });
    }
  });

  router.get('/callback', async (req: Request, res: Response) => {
    const installationId = strParam(req.query['installation_id']);
    const state = strParam(req.query['state']);
    const setupAction = strParam(req.query['setup_action']);

    if (!installationId || !state) {
      return redirectErr(res, resolveSettingsUrl(req), 'missing installation_id or state');
    }
    if (setupAction && setupAction !== 'install' && setupAction !== 'update') {
      return redirectErr(res, resolveSettingsUrl(req), `unsupported setup_action: ${setupAction}`);
    }

    const cfg = await deps.githubAppConfig.get(state);
    if (!cfg) {
      return redirectErr(res, resolveSettingsUrl(req), 'github_not_registered');
    }

    try {
      const { token, expiresAt, owner } = await exchange(cfg, installationId);
      const connectorId = randomUUID();
      const connector = await deps.createConnector({
        id: connectorId,
        orgId: state,
        type: 'github',
        name: `${owner} (GitHub)`,
        config: { owner, installationId },
        createdBy: 'system:github-oauth',
      });
      await deps.upsertSecret({
        connectorId: connector.id,
        ciphertext: new TextEncoder().encode(JSON.stringify({ token, expiresAt })),
      });
      res.redirect(`${resolveSettingsUrl(req)}?github=connected`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, installationId }, 'github callback failed');
      redirectErr(res, resolveSettingsUrl(req), message);
    }
  });

  return router;
}

function sweepExpired(states: Map<string, StateEntry>): void {
  const now = Date.now();
  for (const [k, v] of states.entries()) {
    if (v.expiresAt <= now) states.delete(k);
  }
}

function strParam(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function redirectErr(res: Response, settingsUrl: string, reason: string): void {
  res.redirect(`${settingsUrl}?github=error&reason=${encodeURIComponent(reason)}`);
}
