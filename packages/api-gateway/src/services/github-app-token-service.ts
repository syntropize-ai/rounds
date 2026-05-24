/**
 * GithubAppTokenService — mints and caches GitHub App **installation** tokens
 * on behalf of the org's chat agent tools (github_list_repos, github_list_prs,
 * github_get_pr, github_get_diff).
 *
 * Why this exists separately from `services/github-app.ts`:
 *   - `github-app.ts` exposes one-shot `exchangeInstallationForToken()` used
 *     by the install / sync routes — every call mints a fresh App JWT and
 *     hits GitHub. That's fine for setup-time flows that run once.
 *   - Agent tools fire on every chat turn. We don't want a JWT-sign + 2x
 *     GitHub round-trip per `github_*` call when GitHub already hands us a
 *     1-hour token. This service caches the installation token in memory
 *     keyed by (orgId, installationId) and only refreshes when the cached
 *     entry is within 60s of expiry.
 *
 * We deliberately reuse `signAppJwt()` from github-app.ts (the App's RS256
 * JWT helper). The repo's `get(orgId)` already decrypts the private key —
 * no field-level decryption logic here.
 */

import { createLogger } from '@agentic-obs/server-utils/logging';
import type {
  GithubAppConfig,
  IGithubAppConfigRepository,
  IConnectorRepository,
} from '@agentic-obs/data-layer';
import { signAppJwt } from './github-app.js';

const log = createLogger('github-app-token-service');

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Refresh tokens this many ms before GitHub expires them. */
const REFRESH_MARGIN_MS = 60_000;

export interface GithubAppTokenServiceDeps {
  githubAppConfig: IGithubAppConfigRepository;
  connectors: IConnectorRepository;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam. Defaults to Date.now. */
  now?: () => number;
}

export class GithubAppTokenService {
  private readonly cache = new Map<string, CachedToken>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: GithubAppTokenServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Resolve a fresh installation token for the org's connector.
   * Throws on missing config / connector / installation id.
   */
  async getInstallationToken(orgId: string, connectorId: string): Promise<string> {
    const connector = await this.deps.connectors.get(connectorId, { orgId });
    if (!connector) {
      throw new Error(`GitHub connector "${connectorId}" not found in org ${orgId}.`);
    }
    if (connector.type !== 'github') {
      throw new Error(`Connector "${connector.name}" is type "${connector.type}", not "github".`);
    }
    const installationId = connector.config['installationId'];
    if (typeof installationId !== 'string' || !installationId) {
      throw new Error(`GitHub connector "${connector.name}" has no installationId in its config.`);
    }

    const cacheKey = `${orgId}:${installationId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > this.now()) {
      return cached.token;
    }

    const cfg = await this.deps.githubAppConfig.get(orgId);
    if (!cfg) {
      throw new Error(`GitHub App is not registered for org ${orgId}.`);
    }

    const fresh = await this.mintInstallationToken(cfg, installationId);
    this.cache.set(cacheKey, fresh);
    return fresh.token;
  }

  private async mintInstallationToken(
    cfg: GithubAppConfig,
    installationId: string,
  ): Promise<CachedToken> {
    const jwt = signAppJwt(cfg);
    const res = await this.fetchImpl(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'rounds-api-gateway',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) {
      const detail = await safeText(res);
      log.warn({ installationId, status: res.status, detail }, 'installation token mint failed');
      throw new Error(`installation token mint failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) {
      throw new Error('installation token response missing token/expires_at');
    }
    const expiresAtMs = Date.parse(body.expires_at);
    if (Number.isNaN(expiresAtMs)) {
      throw new Error(`installation token expires_at is not parseable: ${body.expires_at}`);
    }
    return { token: body.token, expiresAtMs };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return '';
  }
}
