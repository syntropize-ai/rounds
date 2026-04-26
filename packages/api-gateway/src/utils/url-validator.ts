import { isIP } from 'node:net';
import * as dns from 'node:dns/promises';

const DNS_LOOKUP_TIMEOUT_MS = 2_500;

/**
 * SSRF posture
 * ============
 * openobs has two deployment shapes:
 *
 *  - **Self-hosted / single-host** (npm install -g openobs, docker run, helm
 *    chart on a workload cluster with Prometheus sidecar). Operators
 *    routinely point at http://localhost:9090 / http://prometheus.monitoring
 *    — blocking RFC1918 or loopback here is a bug, not a feature.
 *
 *  - **Multi-tenant / public-facing** (hosted SaaS, shared gateway in a
 *    corporate network). Blocking private / loopback / link-local is
 *    mandatory or a tenant can pivot through the gateway to hit
 *    internal services.
 *
 * We gate on `OPENOBS_ALLOW_PRIVATE_URLS` / `NODE_ENV=production`:
 *
 *   production mode → block private ranges (matches Grafana Enterprise's
 *                     `data_source_security` default).
 *   any other mode  → allow them (matches OSS Grafana, which permits
 *                     loopback/private URLs in its datasource config UI).
 *
 * Operators running a hardened self-hosted install can still opt into
 * strict mode with `OPENOBS_ALLOW_PRIVATE_URLS=false`; operators running
 * a multi-tenant openobs who need to reach an internal service from a
 * public deploy can opt out with `OPENOBS_ALLOW_PRIVATE_URLS=true`.
 */

function privateUrlsAllowed(): boolean {
  const explicit = process.env['OPENOBS_ALLOW_PRIVATE_URLS'];
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return process.env['NODE_ENV'] !== 'production';
}

/**
 * Returns true if the given hostname resolves to a private, loopback,
 * or link-local address.
 *
 * Blocks: 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x,
 *         169.254.x.x, 0.0.0.0, ::1, fc/fd (ULA), fe80 (link-local).
 */
export function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = octets;
    return (
      a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }

  return false;
}

/** Back-compat alias — older callers used `isBlockedHost`. */
export const isBlockedHost = isPrivateHost;

async function lookupHostname(hostname: string): Promise<string | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dns.lookup(hostname).then(({ address }) => address),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Validates that a URL is safe for server-side requests.
 * Throws if the URL is malformed, uses a disallowed protocol, or targets a
 * blocked host. "Blocked" depends on deployment mode (see SSRF posture above).
 *
 * Also resolves the hostname via DNS and checks whether the resolved IP
 * is private/loopback to prevent DNS rebinding attacks — gated by the same
 * policy.
 */
export async function ensureSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('URL must use http or https');
  }

  const allowPrivate = privateUrlsAllowed();

  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new Error(
      'URL host is not allowed (private/loopback address). Set '
      + 'OPENOBS_ALLOW_PRIVATE_URLS=true to enable access to localhost or RFC1918 ranges.',
    );
  }

  // DNS-rebinding check: even if the hostname itself is public, resolved
  // IPs may be private. Only enforced in strict mode.
  if (!allowPrivate && !isIP(parsed.hostname)) {
    try {
      const address = await lookupHostname(parsed.hostname);
      if (address !== null && isPrivateHost(address)) {
        throw new Error('URL host resolves to a blocked (private/loopback) address');
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('blocked')) {
        throw err;
      }
      // Swallow DNS failures; unreachable hosts fail at fetch-time with a
      // concrete message, which is more useful than a bare DNS error here.
    }
  }

  return parsed;
}
