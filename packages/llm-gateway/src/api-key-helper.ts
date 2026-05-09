import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@agentic-obs/common/logging';

const log = createLogger('api-key-helper');
const execFileAsync = promisify(execFile);

/**
 * Cache entry for a resolved helper output. The cache is keyed on a
 * canonical serialization of the helper config so two providers configured
 * with the same command share a single in-flight exec — useful when an org
 * rotates a single upstream credential used by multiple LLM endpoints.
 */
interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Time-to-live for cached helper output. The model uses the cached value
 *  until this expires, then re-execs the helper on the next call. */
const TTL_MS = 5 * 60 * 1000;

/** Cap how long the helper command may take. Prevents a misconfigured
 *  helper from blocking every LLM call indefinitely. */
const EXEC_TIMEOUT_MS = 10_000;

/** Cap stdout to 1MB. Real helpers print a single short token; anything
 *  larger is suspicious and we'd rather fail fast than buffer it. */
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

/**
 * Structured helper config — argv form, never goes through a shell.
 * `command` is the executable (absolute path or PATH-resolved), `args` is
 * the argv tail. Args are passed literally; shell metacharacters are NOT
 * interpreted.
 */
export interface ApiKeyHelperConfig {
  command: string;
  args?: string[];
}

export interface ApiKeyResolverOptions {
  /** Static API key — used when no helper is configured. */
  staticKey?: string | null;
  /**
   * Helper config. Accepted shapes:
   *   - `ApiKeyHelperConfig` object: `{ command, args? }` — preferred.
   *   - JSON-encoded string of the same shape (for transport over wire
   *     formats that haven't migrated to a structured field yet).
   *
   * Backwards-compat note: legacy raw shell strings (e.g.
   * `"aws ssm get-parameter --name foo"`) are REJECTED with a validation
   * error. Operators must migrate to the structured form. We deliberately
   * do not auto-split with shell-quote because doing so silently masks the
   * change and reintroduces the `exec(string)` ergonomic pitfall this
   * change exists to remove.
   *
   * TODO(api-key-helper): the wire-config / DB schema still types this as
   * a plain `string`. The backend boundary parses it as JSON here. When
   * the UI form ships a structured editor, retype the whole pipeline to
   * `ApiKeyHelperConfig` end-to-end and drop the JSON-string path.
   */
  helperCommand?: string | ApiKeyHelperConfig | null;
}

export class ApiKeyHelperConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyHelperConfigError';
  }
}

/**
 * Build a key resolver that the gateway calls before every LLM request.
 * When a helper is configured, the resolver execFiles it (with a 5-min TTL
 * cache) and returns trimmed stdout. Otherwise it returns the static key.
 *
 * Returns an async function so callers can `await resolver()` regardless of
 * whether a helper is in play — the call site doesn't have to branch.
 */
export function buildApiKeyResolver(opts: ApiKeyResolverOptions): () => Promise<string> {
  const staticKey = opts.staticKey ?? '';
  const helper = parseHelper(opts.helperCommand);

  if (!helper) {
    return async () => staticKey;
  }

  const cacheKey = JSON.stringify([helper.command, helper.args ?? []]);

  return async () => {
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    // Coalesce concurrent calls for the same helper into one exec — otherwise
    // a burst of LLM requests would each fork their own process.
    const existing = inflight.get(cacheKey);
    if (existing) return existing;
    const p = execHelper(helper)
      .then((value) => {
        cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
        return value;
      })
      .finally(() => {
        inflight.delete(cacheKey);
      });
    inflight.set(cacheKey, p);
    return p;
  };
}

/**
 * Normalize the input into a validated `ApiKeyHelperConfig`, or `null` when
 * no helper is configured. Throws `ApiKeyHelperConfigError` for malformed
 * input — including legacy plain shell strings.
 */
function parseHelper(
  input: string | ApiKeyHelperConfig | null | undefined,
): ApiKeyHelperConfig | null {
  if (input == null) return null;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Only JSON object form is accepted from string input. We don't auto-split
    // raw shell strings — that would silently undo the safer-by-default goal.
    if (!trimmed.startsWith('{')) {
      throw new ApiKeyHelperConfigError(
        'apiKeyHelper must be a JSON object {"command":"...","args":[...]} — raw shell strings are no longer accepted.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ApiKeyHelperConfigError(
        'apiKeyHelper string must be valid JSON of shape {"command":"...","args":[...]}.',
      );
    }
    return validateConfig(parsed);
  }

  return validateConfig(input);
}

function validateConfig(value: unknown): ApiKeyHelperConfig {
  if (!value || typeof value !== 'object') {
    throw new ApiKeyHelperConfigError('apiKeyHelper must be an object with a `command` field.');
  }
  const obj = value as Record<string, unknown>;
  const command = obj['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new ApiKeyHelperConfigError('apiKeyHelper.command must be a non-empty string.');
  }
  const rawArgs = obj['args'];
  let args: string[] | undefined;
  if (rawArgs !== undefined && rawArgs !== null) {
    if (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === 'string')) {
      throw new ApiKeyHelperConfigError('apiKeyHelper.args must be an array of strings.');
    }
    args = rawArgs as string[];
  }
  return args !== undefined ? { command: command.trim(), args } : { command: command.trim() };
}

async function execHelper(cfg: ApiKeyHelperConfig): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cfg.command, cfg.args ?? [], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      // Explicitly do NOT enable a shell — execFile spawns the binary
      // directly so args are passed as argv and shell metacharacters
      // ($, ;, |, backticks) are NEVER interpreted.
      shell: false,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      // Don't echo back command details that may include sensitive paths;
      // operator can correlate via logs.
      throw new Error('api-key-helper produced empty stdout');
    }
    return trimmed;
  } catch (err) {
    // NEVER include raw stdout in the thrown error — that's where the API
    // key would be. Only surface the command name + a short error class.
    const errName = err instanceof Error ? err.name : 'Error';
    const errCode =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    log.error(
      { command: cfg.command, errName, errCode },
      'api-key-helper failed',
    );
    const detail = errCode ? `${errName} (${errCode})` : errName;
    throw new Error(`api-key-helper failed: ${detail}`);
  }
}

/** Test-only: drop everything cached. Production callers don't need this. */
export function _resetApiKeyHelperCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
