/**
 * Kubeconfig `user.exec` credential plugin runner.
 *
 * SECURITY: connector configs (including kubeconfigs) can be user-provided,
 * and this code runs on the api-gateway host. A naive `exec` of whatever the
 * kubeconfig says is a remote code execution vulnerability.
 *
 * Defense in depth applied here:
 *   1. Feature-gated: disabled unless `KUBECONFIG_EXEC_PLUGIN=1` is set on
 *      the api-gateway process environment.
 *   2. Strict allowlist: only `kubectl oidc-login get-token ...` is permitted.
 *      No other binary, no other subcommand.
 *   3. `execFile` (no shell): the command and args are passed as an argv array
 *      to the OS, so shell metacharacters in args cannot trigger interpretation.
 *   4. Env scrubbing: the child process gets PATH + HOME from the parent ONLY,
 *      plus whatever the kubeconfig `user.exec.env` block declares (which is
 *      itself part of the connector secret — same trust boundary as the rest
 *      of the kubeconfig).
 *   5. Timeout + maxBuffer: kills runaways and prevents stdout-bomb DoS.
 *   6. In-process token cache: tokens are cached until 30s before their
 *      `status.expirationTimestamp`, then refreshed. Bounds the exec rate.
 *   7. Audit log: connector id, command, duration, ok — NEVER the token,
 *      NEVER full stderr (which oidc-login may print user identifiers into).
 */

import { execFile } from 'node:child_process';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('kubeconfig-exec');

// --- Tunable safety defaults (top of file for easy review) -----------------

/** Env var that must be set to '1' on the api-gateway to enable exec at all. */
const EXEC_ENABLED_ENV = 'KUBECONFIG_EXEC_PLUGIN';

/** Only this command is allowed. No path, must be a bare name resolved via PATH. */
const ALLOWED_COMMAND = 'kubectl';

/** The first two args must match exactly. Further args (issuer URL, client-id) pass through. */
const REQUIRED_LEADING_ARGS: ReadonlyArray<string> = ['oidc-login', 'get-token'];

/** Hard ceiling on exec duration. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Hard ceiling on combined stdout+stderr bytes. */
const DEFAULT_MAX_BUFFER = 1 * 1024 * 1024;

/** Refresh the cached token this many ms before its declared expiry. */
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

/** Parent-process env vars passed through to the child. */
const PARENT_ENV_ALLOWLIST: ReadonlyArray<string> = ['PATH', 'HOME'];

/**
 * Env names that are NEVER set on the child, regardless of source. Loader
 * hijack vectors (LD_ and DYLD_ prefixes) and Node's NODE_OPTIONS (arbitrary --require).
 * Case-sensitive on POSIX, which is what we target.
 */
const ENV_DENYLIST: ReadonlySet<string> = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
]);

/** Hard cap on total argv length (command + args). */
const MAX_ARGS = 20;

/** Hard cap on per-arg byte length. */
const MAX_ARG_BYTES = 1024;

/**
 * Allowlist of arg shapes accepted beyond the two mandatory leading args.
 *
 * `prefix` entries match `arg.startsWith(prefix)` (value not validated).
 * `exact` entries require an exact bare match (for boolean flags).
 */
const EXTRA_ARG_PREFIXES: ReadonlyArray<string> = [
  '--issuer-url=',
  '--client-id=',
  '--client-secret=',
  '--extra-scope=',
  '--listen-address=',
  '--username=',
  '--password=',
  '--token-cache-dir=',
  '--certificate-authority=',
  '--certificate-authority-data=',
  '--v=',
];

const EXTRA_ARG_EXACT: ReadonlySet<string> = new Set([
  '--skip-open-browser',
  '--insecure-skip-tls-verify',
  '-v',
]);

/** User-facing error when exec is gated off. */
export const EXEC_DISABLED_MESSAGE =
  'Kubeconfig exec auth requires KUBECONFIG_EXEC_PLUGIN=1 on the api-gateway.';

// --- Types ----------------------------------------------------------------

export interface KubeconfigExecSpec {
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  apiVersion?: string;
}

export interface ResolveExecCredentialOpts {
  connectorId: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface ResolvedExecCredential {
  token: string;
  expiresAt: Date | null;
}

interface ExecCredentialResponse {
  apiVersion?: string;
  kind?: string;
  status?: {
    token?: string;
    expirationTimestamp?: string;
  };
}

// --- Cache ----------------------------------------------------------------

interface CacheEntry {
  token: string;
  expiresAt: Date | null;
}

const tokenCache = new Map<string, CacheEntry>();

function cacheKey(spec: KubeconfigExecSpec, connectorId: string): string {
  // Include only fields that affect the child invocation. Env order matters
  // semantically (last write wins) so preserve declared order. connectorId
  // is included so two connectors with identical exec specs get isolated
  // cache entries (and audit logs can distinguish refreshes per connector).
  return JSON.stringify({
    connectorId,
    command: spec.command,
    args: spec.args ?? [],
    env: (spec.env ?? []).map((e) => [e.name, e.value]),
  });
}

/** Soft cap on cache size; evict insertion-oldest when exceeded. */
const TOKEN_CACHE_MAX = 128;

function isFresh(entry: CacheEntry, now: number): boolean {
  if (!entry.expiresAt) return false; // No expiry declared → don't trust cache
  return entry.expiresAt.getTime() - now > EXPIRY_SAFETY_MARGIN_MS;
}

// --- Public API -----------------------------------------------------------

export function isExecPluginEnabled(): boolean {
  return process.env[EXEC_ENABLED_ENV] === '1';
}

export async function resolveExecCredential(
  spec: KubeconfigExecSpec,
  opts: ResolveExecCredentialOpts,
): Promise<ResolvedExecCredential> {
  if (!isExecPluginEnabled()) {
    throw new Error(EXEC_DISABLED_MESSAGE);
  }

  // Allowlist gate. Command must be the bare allowed name; args[0..1] must
  // match required leading args exactly.
  if (spec.command !== ALLOWED_COMMAND) {
    throw new Error(
      `Kubeconfig exec command "${spec.command}" is not allowed. Only "${ALLOWED_COMMAND}" is permitted.`,
    );
  }
  const args = spec.args ?? [];
  for (let i = 0; i < REQUIRED_LEADING_ARGS.length; i++) {
    if (args[i] !== REQUIRED_LEADING_ARGS[i]) {
      throw new Error(
        `Kubeconfig exec args must begin with "${REQUIRED_LEADING_ARGS.join(' ')}". Got: "${args.slice(0, REQUIRED_LEADING_ARGS.length).join(' ')}".`,
      );
    }
  }
  if (args.length > MAX_ARGS) {
    throw new Error(`Kubeconfig exec args exceed maximum count of ${MAX_ARGS}.`);
  }
  for (let i = REQUIRED_LEADING_ARGS.length; i < args.length; i++) {
    const a = args[i]!;
    if (Buffer.byteLength(a, 'utf8') > MAX_ARG_BYTES) {
      throw new Error(`Kubeconfig exec arg #${i} exceeds ${MAX_ARG_BYTES} bytes.`);
    }
    if (EXTRA_ARG_EXACT.has(a)) continue;
    if (EXTRA_ARG_PREFIXES.some((p) => a.startsWith(p))) continue;
    throw new Error(`Kubeconfig exec arg "${a}" is not in the allowlist.`);
  }

  const key = cacheKey(spec, opts.connectorId);
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached && isFresh(cached, now)) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  // Env composition order (host always wins for PATH/HOME):
  //   1. Start empty — never inherit parent env wholesale.
  //   2. Layer kubeconfig user.exec.env entries FIRST.
  //   3. Layer parent allowlist LAST so the host's PATH/HOME override any
  //      attempt to redirect the loader/PATH via the kubeconfig.
  // Denylist (loader hijack, NODE_OPTIONS) is enforced regardless of source.
  const filteredEnv: Record<string, string> = {};
  for (const e of spec.env ?? []) {
    if (typeof e?.name === 'string' && typeof e?.value === 'string') {
      if (ENV_DENYLIST.has(e.name)) continue;
      filteredEnv[e.name] = e.value;
    }
  }
  for (const name of PARENT_ENV_ALLOWLIST) {
    if (ENV_DENYLIST.has(name)) continue;
    const v = process.env[name];
    if (typeof v === 'string') filteredEnv[name] = v;
  }

  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const started = Date.now();

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      spec.command,
      args,
      {
        timeout,
        maxBuffer,
        env: filteredEnv,
        // Explicit: no shell. (execFile defaults to no shell, but the
        // intent matters for review.)
        shell: false,
        windowsHide: true,
      },
      (err, sout) => {
        if (err) {
          // Surface a generic class of failure to the caller without leaking
          // stderr (oidc-login can print user emails / claims into it).
          const code = (err as NodeJS.ErrnoException).code;
          // Node signals an execFile timeout by SIGTERM-killing the child;
          // ETIMEDOUT here would be a network/IO code (which execFile doesn't
          // actually emit for the timeout path). Use the killed/signal pair.
          const e = err as Error & { killed?: boolean; signal?: NodeJS.Signals };
          if (e.killed === true || e.signal === 'SIGTERM') {
            reject(new Error(`kubeconfig exec timed out after ${timeout}ms`));
          } else if (code === 'ENOENT') {
            reject(new Error(`exec credential plugin "${spec.command}" not found on PATH`));
          } else {
            reject(new Error(`exec credential plugin failed (${code ?? 'error'})`));
          }
          return;
        }
        resolve(sout);
      },
    );
  }).catch((err) => {
    log.warn(
      {
        connectorId: opts.connectorId,
        command: spec.command,
        durationMs: Date.now() - started,
        ok: false,
      },
      'kubeconfig exec credential failed',
    );
    throw err;
  });

  let parsed: ExecCredentialResponse;
  try {
    parsed = JSON.parse(stdout) as ExecCredentialResponse;
  } catch {
    log.warn(
      { connectorId: opts.connectorId, command: spec.command, durationMs: Date.now() - started, ok: false },
      'kubeconfig exec credential returned non-JSON',
    );
    throw new Error('exec credential plugin did not return valid JSON');
  }

  if (
    parsed.kind !== 'ExecCredential' ||
    typeof parsed.apiVersion !== 'string' ||
    !parsed.apiVersion.startsWith('client.authentication.k8s.io/')
  ) {
    log.warn(
      { connectorId: opts.connectorId, command: spec.command, durationMs: Date.now() - started, ok: false },
      'kubeconfig exec credential returned wrong shape',
    );
    throw new Error('exec credential plugin returned an unexpected response shape');
  }

  const token = parsed.status?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('exec credential plugin returned no token');
  }

  let expiresAt: Date | null = null;
  const expStr = parsed.status?.expirationTimestamp;
  if (typeof expStr === 'string') {
    const t = Date.parse(expStr);
    if (Number.isFinite(t)) expiresAt = new Date(t);
  }

  // Never cache without a declared expiry — an unbounded entry would never
  // refresh and the token would silently outlive its real validity.
  if (expiresAt) {
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
      // Map preserves insertion order — drop the oldest entry.
      const oldest = tokenCache.keys().next().value;
      if (oldest !== undefined) tokenCache.delete(oldest);
    }
    tokenCache.set(key, { token, expiresAt });
  }

  log.info(
    {
      connectorId: opts.connectorId,
      command: spec.command,
      durationMs: Date.now() - started,
      ok: true,
    },
    'kubeconfig exec credential refreshed',
  );

  return { token, expiresAt };
}

/** Test-only: clear the in-process cache. */
export function __clearExecCredentialCache(): void {
  tokenCache.clear();
}
