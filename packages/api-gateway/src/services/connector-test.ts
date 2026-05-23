/**
 * Connector "test connection" implementations.
 *
 * Replaces the fake `{ ok: true }` fallback in `ConnectorService.test()`
 * with real backend probes driven off each connector template's
 * `verify` strategy. The router calls `testConnectorAgainstBackend`
 * with the connector row and the decrypted secret (or null when the
 * credential kind is 'none').
 */

import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { Connector } from '@agentic-obs/common';
import { getConnectorTemplate, type ConnectorType } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('connector-test');

export interface ConnectorTestOutcome {
  ok: boolean;
  message?: string;
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const IN_CLUSTER_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

export async function testConnectorAgainstBackend(
  connector: Connector,
  secret: string | null,
): Promise<ConnectorTestOutcome> {
  const template = getConnectorTemplate(connector.type as ConnectorType);
  if (!template) {
    return { ok: false, message: `Unknown connector type: ${connector.type}` };
  }
  const verify = template.verify;
  switch (verify.kind) {
    case 'http-get':
      return testHttpGet(connector, secret, verify.path);
    case 'kubernetes-version':
      return testKubernetesVersion(connector, secret);
    case 'github-api':
      return testGithubApi(connector, secret);
    case 'none':
      return { ok: true };
    default: {
      const kind = (verify as { kind: string }).kind;
      return { ok: false, message: `Verify strategy "${kind}" not implemented yet` };
    }
  }
}

/**
 * Test a GitHub App installation. The connector's secret is the cached
 * installation token JSON `{ token, expiresAt }` we stored at install time
 * (see /api/connectors/github/callback). Steps:
 *
 *   1. If no secret → "Not installed; click Connect to GitHub".
 *   2. If token expired → expired-message; the user re-installs via
 *      Connect to GitHub to mint a fresh installation token.
 *   3. Otherwise hit GET /installation/repositories with the token. 200 → ok.
 *
 * We don't re-sign a JWT here because the test endpoint doesn't have access
 * to the github_app_config repo — the token approach is sufficient for "is
 * this connector live right now?" and avoids leaking the App's private key
 * into this code path.
 */
async function testGithubApi(
  connector: Connector,
  secret: string | null,
): Promise<ConnectorTestOutcome> {
  if (!secret) {
    return { ok: false, message: 'Not installed. Click "Connect to GitHub" to install the App on your account.' };
  }
  let parsed: { token?: string; expiresAt?: string };
  try {
    parsed = JSON.parse(secret) as { token?: string; expiresAt?: string };
  } catch {
    return { ok: false, message: 'Stored credentials are malformed. Re-install via Connect to GitHub.' };
  }
  const token = parsed.token;
  if (!token) {
    return { ok: false, message: 'No installation token. Re-install via Connect to GitHub.' };
  }
  const expiresAt = parsed.expiresAt;
  if (expiresAt) {
    const exp = Date.parse(expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      return {
        ok: false,
        message: `Installation token expired at ${expiresAt}. Click Connect to GitHub to refresh.`,
      };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const target = 'https://api.github.com/installation/repositories?per_page=1';
  try {
    const res = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `token ${token}`,
      },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    const body = await safeReadBody(res);
    if (res.status === 401) {
      return { ok: false, message: 'GitHub rejected the token. Re-install via Connect to GitHub.' };
    }
    return { ok: false, message: `HTTP ${res.status}`, ...(body ? { detail: body } : {}) };
  } catch (err) {
    const message = errorMessage(err, target);
    log.warn({ connectorId: connector.id, target, err: message }, 'connector test github-api failed');
    if (controller.signal.aborted) {
      return { ok: false, message: `request timed out after ${DEFAULT_TIMEOUT_MS}ms` };
    }
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

async function testHttpGet(
  connector: Connector,
  secret: string | null,
  path: string,
): Promise<ConnectorTestOutcome> {
  const rawUrl = typeof connector.config['url'] === 'string' ? (connector.config['url'] as string) : '';
  if (!rawUrl) return { ok: false, message: 'connector has no url configured' };
  const base = rawUrl.replace(/\/+$/, '');
  const target = `${base}${path}`;

  const template = getConnectorTemplate(connector.type as ConnectorType);
  const headers: Record<string, string> = {};
  if (secret && template?.credential === 'token') {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: 'GET', headers, signal: controller.signal });
    if (res.ok) return { ok: true };
    const body = await safeReadBody(res);
    return {
      ok: false,
      message: `HTTP ${res.status}`,
      ...(body ? { detail: body } : {}),
    };
  } catch (err) {
    const message = errorMessage(err, target);
    log.warn({ connectorId: connector.id, target, err: message }, 'connector test http-get failed');
    if (controller.signal.aborted) {
      return { ok: false, message: `request timed out after ${DEFAULT_TIMEOUT_MS}ms` };
    }
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

async function testKubernetesVersion(
  connector: Connector,
  secret: string | null,
): Promise<ConnectorTestOutcome> {
  const apiServer = typeof connector.config['apiServer'] === 'string'
    ? (connector.config['apiServer'] as string).replace(/\/+$/, '')
    : '';
  const kubeconfig = secret ? parseKubeconfig(secret) : null;
  const targetApiServer = apiServer || kubeconfig?.server?.replace(/\/+$/, '') || '';

  if (targetApiServer) {
    const token = kubeconfig?.token ?? (secret ? extractKubeconfigToken(secret) : null);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (kubeconfig?.clientCertificate && kubeconfig.clientKey) {
      return runK8sVersionHttpsRequest(
        `${targetApiServer}/version`,
        {
          headers,
          cert: kubeconfig.clientCertificate,
          key: kubeconfig.clientKey,
          ca: kubeconfig.certificateAuthority,
        },
        connector.id,
      );
    }
    return runK8sVersionFetch(`${targetApiServer}/version`, headers, connector.id);
  }

  // No apiServer: only viable if running in-cluster.
  let inClusterToken: string;
  try {
    inClusterToken = await readFile(IN_CLUSTER_TOKEN_PATH, 'utf8');
  } catch {
    return { ok: false, message: 'apiServer required when not running in-cluster' };
  }
  return runK8sVersionFetch(
    'https://kubernetes.default.svc/version',
    { Authorization: `Bearer ${inClusterToken.trim()}`, Accept: 'application/json' },
    connector.id,
  );
}

interface ParsedKubeconfig {
  server?: string;
  certificateAuthority?: string;
  clientCertificate?: string;
  clientKey?: string;
  token?: string;
}

function parseKubeconfig(input: string): ParsedKubeconfig | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const cfg = JSON.parse(trimmed) as {
      clusters?: Array<{ cluster?: Record<string, unknown> }>;
      users?: Array<{ user?: Record<string, unknown> }>;
    };
    const cluster = cfg.clusters?.[0]?.cluster;
    const user = cfg.users?.[0]?.user;
    const out: ParsedKubeconfig = {};
    if (typeof cluster?.['server'] === 'string') out.server = cluster['server'];
    if (typeof cluster?.['certificate-authority-data'] === 'string') {
      out.certificateAuthority = decodeBase64Pem(cluster['certificate-authority-data']);
    }
    if (typeof user?.['client-certificate-data'] === 'string') {
      out.clientCertificate = decodeBase64Pem(user['client-certificate-data']);
    }
    if (typeof user?.['client-key-data'] === 'string') {
      out.clientKey = decodeBase64Pem(user['client-key-data']);
    }
    if (typeof user?.['token'] === 'string') out.token = user['token'];
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    const out: ParsedKubeconfig = {};
    const server = trimmed.match(/^\s*server:\s*([^\s#]+)/m)?.[1];
    if (server) out.server = server.replace(/^["']|["']$/g, '');
    const ca = trimmed.match(/^\s*certificate-authority-data:\s*([^\s#]+)/m)?.[1];
    if (ca) out.certificateAuthority = decodeBase64Pem(ca.replace(/^["']|["']$/g, ''));
    const cert = trimmed.match(/^\s*client-certificate-data:\s*([^\s#]+)/m)?.[1];
    if (cert) out.clientCertificate = decodeBase64Pem(cert.replace(/^["']|["']$/g, ''));
    const key = trimmed.match(/^\s*client-key-data:\s*([^\s#]+)/m)?.[1];
    if (key) out.clientKey = decodeBase64Pem(key.replace(/^["']|["']$/g, ''));
    const token = extractKubeconfigToken(trimmed);
    if (token) out.token = token;
    return Object.keys(out).length > 0 ? out : null;
  }
}

function decodeBase64Pem(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

async function runK8sVersionHttpsRequest(
  url: string,
  opts: { headers: Record<string, string>; ca?: string; cert: string; key: string },
  connectorId: string,
): Promise<ConnectorTestOutcome> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        headers: opts.headers,
        ca: opts.ca,
        cert: opts.cert,
        key: opts.key,
        timeout: DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve({ ok: true });
            return;
          }
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: false,
            message: `HTTP ${status}`,
            ...(body ? { detail: body.length > 200 ? `${body.slice(0, 200)}…` : body } : {}),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    });
    req.on('error', (err) => {
      const message = errorMessage(err, url);
      log.warn({ connectorId, url, err: message }, 'connector test kubernetes-version failed');
      resolve({ ok: false, message });
    });
    req.end();
  });
}

async function runK8sVersionFetch(
  url: string,
  headers: Record<string, string>,
  connectorId: string,
): Promise<ConnectorTestOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.ok) return { ok: true };
    const body = await safeReadBody(res);
    return { ok: false, message: `HTTP ${res.status}`, ...(body ? { detail: body } : {}) };
  } catch (err) {
    const message = errorMessage(err, url);
    log.warn({ connectorId, url, err: message }, 'connector test kubernetes-version failed');
    if (controller.signal.aborted) {
      return { ok: false, message: `request timed out after ${DEFAULT_TIMEOUT_MS}ms` };
    }
    if (/cert|self.signed|TLS|unable to verify/i.test(message)) {
      return { ok: false, message: 'TLS cert validation failed; in-cluster auth requires real CA' };
    }
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a bearer token from a kubeconfig YAML string. We avoid adding a
 * YAML parser dependency to api-gateway: kubeconfigs have a stable shape
 * and a `token: <value>` line under the `user:` block of an entry in
 * `users:` is the conventional spot. This is a best-effort extraction —
 * if no token is found, callers fall back to unauthenticated.
 */
function extractKubeconfigToken(kubeconfig: string): string | null {
  // Strip surrounding quotes if any
  const trimmed = kubeconfig.trim();
  // If the input is a raw token (no newlines, no "users:"), use it as-is.
  if (!trimmed.includes('\n') && !trimmed.includes('users:')) {
    return trimmed || null;
  }
  const match = trimmed.match(/^\s*token:\s*([^\s#]+)/m);
  return match ? match[1]!.replace(/^["']|["']$/g, '') : null;
}

async function safeReadBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return null;
  }
}

/**
 * Humanize node fetch's terse "fetch failed" + cause chain into a message
 * an operator can act on. The common causes we surface:
 *   - ECONNREFUSED → "Cannot connect — is <host>:<port> running?"
 *   - ENOTFOUND    → "Host <host> does not resolve"
 *   - ETIMEDOUT    → "Connection timed out"
 *   - DEPTH_ZERO_SELF_SIGNED_CERT / similar → "TLS verification failed: <code>"
 * Anything else falls back to the raw message.
 */
function errorMessage(err: unknown, target?: string): string {
  if (!(err instanceof Error)) return String(err);
  // Node's fetch wraps low-level errors in `cause`. The original raw message
  // ("fetch failed") is useless; walk into the cause chain.
  let cur: unknown = err;
  let bestCode: string | null = null;
  let bestMsg: string | null = null;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (cur instanceof Error) {
      const e = cur as Error & { code?: string; cause?: unknown };
      if (typeof e.code === 'string' && !bestCode) bestCode = e.code;
      if (e.message && e.message !== 'fetch failed') bestMsg = e.message;
      cur = e.cause;
    } else {
      break;
    }
  }
  const hostPort = target ? new URL(target).host : '';
  switch (bestCode) {
    case 'ECONNREFUSED':
      return `Cannot connect to ${hostPort || 'target'} — is the service running and reachable?`;
    case 'ENOTFOUND':
      return `Host '${hostPort || target}' does not resolve. Check the URL.`;
    case 'ETIMEDOUT':
      return `Connection to ${hostPort || target} timed out`;
    case 'ECONNRESET':
      return `Connection to ${hostPort || target} was reset before a response arrived`;
    case 'EHOSTUNREACH':
      return `Host ${hostPort || target} is unreachable from this server`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `TLS verification failed (${bestCode}). Connector is reachable but its certificate isn't trusted.`;
  }
  return bestMsg ?? err.message;
}
