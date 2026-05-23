/**
 * GitHub App helpers — JWT signing and installation token exchange.
 *
 * Each instance now stores its own GitHub App credentials in the
 * `github_app_config` table (one row per org), registered via GitHub's
 * App Manifest flow. There is no env-var fallback: callers must load the
 * config from the repository and pass it in.
 *
 * We avoid the `jsonwebtoken` dep for signing — Node's built-in `crypto`
 * does RS256 in a few lines, and that keeps test-time stubbing simple.
 */

import { createSign } from 'node:crypto';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type {
  GithubAppConfig,
  IGithubAppConfigRepository,
} from '@agentic-obs/data-layer';

const log = createLogger('github-app');

export async function getGithubAppConfig(
  orgId: string,
  repo: IGithubAppConfigRepository,
): Promise<GithubAppConfig | null> {
  return repo.get(orgId);
}

export async function isGithubAppRegistered(
  orgId: string,
  repo: IGithubAppConfigRepository,
): Promise<boolean> {
  const cfg = await repo.get(orgId);
  return cfg !== null;
}

export function buildInstallUrl(config: GithubAppConfig, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export function signAppJwt(config: GithubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: String(config.appId) };
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(config.privateKey).toString('base64');
  const encSig = signature.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${encSig}`;
}

export interface InstallationExchangeResult {
  token: string;
  expiresAt: string;
  owner: string;
}

export interface GithubInstallationSummary {
  id: string;
  owner: string;
}

export async function listGithubAppInstallations(
  config: GithubAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubInstallationSummary[]> {
  const jwt = signAppJwt(config);
  const res = await fetchImpl('https://api.github.com/app/installations', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rounds-api-gateway',
    },
  });
  if (!res.ok) {
    const detail = await safeText(res);
    log.warn({ status: res.status, detail }, 'github installations list failed');
    throw new Error(`installations list failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as Array<{
    id?: number | string;
    account?: { login?: string };
  }>;
  return body
    .map((item) => ({
      id: item.id === undefined ? '' : String(item.id),
      owner: item.account?.login ?? '',
    }))
    .filter((item) => item.id.length > 0 && item.owner.length > 0);
}

export async function exchangeInstallationForToken(
  config: GithubAppConfig,
  installationId: string,
): Promise<InstallationExchangeResult> {
  const jwt = signAppJwt(config);
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'rounds-api-gateway',
  };

  const metaRes = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    { method: 'GET', headers: baseHeaders },
  );
  if (!metaRes.ok) {
    const detail = await safeText(metaRes);
    log.warn({ installationId, status: metaRes.status, detail }, 'github installation lookup failed');
    throw new Error(`installation lookup failed: HTTP ${metaRes.status}`);
  }
  const metaBody = (await metaRes.json()) as { account?: { login?: string } };
  const owner = metaBody.account?.login;
  if (!owner) throw new Error('installation has no account.login');

  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    { method: 'POST', headers: baseHeaders },
  );
  if (!tokenRes.ok) {
    const detail = await safeText(tokenRes);
    log.warn({ installationId, status: tokenRes.status, detail }, 'github installation token mint failed');
    throw new Error(`installation token mint failed: HTTP ${tokenRes.status}`);
  }
  const tokenBody = (await tokenRes.json()) as { token?: string; expires_at?: string };
  if (!tokenBody.token || !tokenBody.expires_at) {
    throw new Error('installation token response missing token/expires_at');
  }
  return { token: tokenBody.token, expiresAt: tokenBody.expires_at, owner };
}

/**
 * Exchange an App Manifest temporary `code` for the App's permanent
 * credentials. GitHub returns `{ id, slug, client_id, client_secret, pem,
 * webhook_secret, ... }` from `POST /app-manifests/<code>/conversions`.
 *
 * Test seam: callers may pass a custom `fetchImpl` (defaults to global
 * `fetch`) so unit tests don't need to stub the global.
 */
export interface ManifestConversionResult {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string | null;
}

export async function convertAppManifest(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversionResult> {
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'rounds-api-gateway',
      },
    },
  );
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`manifest conversion failed: HTTP ${res.status} ${detail}`);
  }
  const body = (await res.json()) as {
    id?: number;
    slug?: string;
    client_id?: string;
    client_secret?: string;
    pem?: string;
    webhook_secret?: string | null;
  };
  if (
    typeof body.id !== 'number' ||
    typeof body.slug !== 'string' ||
    typeof body.client_id !== 'string' ||
    typeof body.client_secret !== 'string' ||
    typeof body.pem !== 'string'
  ) {
    throw new Error('manifest conversion response missing required fields');
  }
  return {
    appId: body.id,
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    privateKey: body.pem,
    webhookSecret: typeof body.webhook_secret === 'string' ? body.webhook_secret : null,
  };
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return '';
  }
}
