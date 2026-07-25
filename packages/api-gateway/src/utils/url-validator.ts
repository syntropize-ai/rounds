import { isIP } from 'node:net';
import * as dns from 'node:dns/promises';

const DNS_LOOKUP_TIMEOUT_MS = 2_500;

/**
 * SSRF posture
 * ============
 * Rounds has two deployment shapes:
 *
 *  - **Self-hosted / single-host** (npm install -g @syntropize/rounds, docker run, helm
 *    chart on a workload cluster with Prometheus sidecar). Operators
 *    routinely point at http://localhost:9090 / http://prometheus.monitoring
 *    — these deployments need RFC1918 and loopback to be reachable.
 *
 *  - **Multi-tenant / public-facing** (hosted SaaS, shared gateway in a
 *    corporate network). Blocking private / loopback / link-local is
 *    mandatory or a tenant can pivot through the gateway to hit
 *    internal services.
 *
 * Blocking is the default: an install that never sets anything gets the safe
 * behaviour, because a deploy that is accidentally reachable is far more
 * common than an operator who cannot read an error message telling them
 * which knob to turn.
 *
 * Operators who genuinely target in-cluster or localhost services opt out
 * with `OPENOBS_ALLOW_PRIVATE_URLS=true`. The helm chart sets exactly that
 * (see helm/rounds/values.yaml) because it deploys next to an in-cluster
 * Prometheus; multi-tenant / public-facing deploys must leave it unset.
 */

function privateUrlsAllowed(): boolean {
  return process.env['OPENOBS_ALLOW_PRIVATE_URLS'] === 'true';
}

/**
 * Expands an IPv6 literal into its eight 16-bit groups, folding any trailing
 * dotted-quad (`::ffff:10.0.0.1`) into the last two groups.
 * Only valid IPv6 literals may be passed.
 */
function expandIpv6(address: string): number[] {
  let head = address;
  const embedded: number[] = [];

  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(head);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map((part) => Number.parseInt(part, 10));
    embedded.push((a! << 8) | b!, (c! << 8) | d!);
    head = head.slice(0, dotted.index);
  }

  const [left, right] = head.split('::');
  const parse = (part: string) => part
    .split(':')
    .filter((group) => group !== '')
    .map((group) => Number.parseInt(group, 16));

  const leading = parse(left!);
  const trailing = right === undefined ? [] : parse(right);
  const missing = 8 - embedded.length - leading.length - trailing.length;
  const zeros = right === undefined ? [] : new Array<number>(missing).fill(0);

  const groups = [...leading, ...zeros, ...trailing, ...embedded];
  if (groups.length !== 8) {
    throw new Error(`Unparsable IPv6 address: ${address}`);
  }
  return groups;
}

/**
 * Strips brackets/case, and rewrites IPv6 forms that carry an IPv4 address in
 * their low 32 bits (`::ffff:10.0.0.1`, its hex spelling `::ffff:a00:1`,
 * `0:0:0:0:0:ffff:10.0.0.1`, and the deprecated IPv4-compatible `::10.0.0.1`)
 * into that IPv4 address. Without this, `::ffff:10.0.0.1` reaches the same
 * host as `10.0.0.1` while walking straight past the RFC1918 check.
 *
 * `::` and `::1` normalize into 0.0.0.0/8, which the IPv4 check blocks.
 */
function normalizeHost(hostname: string): string {
  const stripped = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(stripped) !== 6) return stripped;

  const groups = expandIpv6(stripped);
  const highBitsZero = groups.slice(0, 5).every((group) => group === 0);
  if (!highBitsZero || (groups[5] !== 0 && groups[5] !== 0xffff)) return stripped;

  const [high, low] = [groups[6]!, groups[7]!];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Returns true if the given hostname resolves to a private, loopback,
 * or link-local address.
 *
 * Blocks: 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x,
 *         169.254.x.x, 0.x.x.x, ::/::1, fc/fd (ULA), fe80 (link-local),
 *         and the IPv4-mapped IPv6 spelling of any of the above.
 */
export function isPrivateHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = octets;
    return (
      a === 0
      || a === 10
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
  // IPs may be private. Skipped only when private URLs are allowed.
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
