// Canonical adapter / provider error taxonomy.
//
// One AdapterError class, one stable discriminated-union `kind`, for every
// integration boundary across the codebase: data-source adapters (Prometheus,
// Loki, ...) AND LLM provider clients (OpenAI, Anthropic, ...). Agent code
// (Wave 2) decides what to do based on `kind`, so the shape must be stable.
//
// Phase 1 (this file): define the canonical shape and migrate throws.
// User-visible behavior is unchanged; the wire shape of catch-blocks /
// retry-logic still keys off the same conditions (auth, transient, etc.).

/**
 * Stable discriminator. Add a new kind ONLY when a caller needs to branch on
 * a condition that none of the existing kinds covers — don't expand for
 * cosmetic reasons.
 *
 *   - 'timeout'              : request exceeded its deadline (AbortError / ETIMEDOUT).
 *   - 'dns_failure'          : ENOTFOUND / EAI_AGAIN. Hostname did not resolve.
 *   - 'connection_refused'   : ECONNREFUSED / ECONNRESET. TCP-level failure.
 *   - 'auth_failure'         : HTTP 401/403. Credentials rejected.
 *   - 'rate_limit'           : HTTP 429. Retryable; honor Retry-After.
 *   - 'not_found'            : HTTP 404. Resource / endpoint does not exist.
 *   - 'bad_request'          : HTTP 400. Query parse error, validation failure.
 *   - 'server_error'         : HTTP 5xx. Upstream broke; retryable.
 *   - 'malformed_response'   : 2xx response with unparseable / wrong-shape body.
 *   - 'readonly'             : resource cannot be mutated (e.g. GitOps-provisioned).
 *   - 'unknown'              : everything else. Caller defaults to fail-fast.
 */
export type AdapterErrorKind =
  | 'timeout'
  | 'dns_failure'
  | 'connection_refused'
  | 'auth_failure'
  | 'rate_limit'
  | 'not_found'
  | 'bad_request'
  | 'server_error'
  | 'malformed_response'
  | 'readonly'
  | 'unknown';

/**
 * Structured cause / context. Diagnostics-only — `originalError` MUST NEVER
 * leak into a user-facing string. Use `toUserMessage()` for that.
 */
export interface AdapterErrorCause {
  /** Stable adapter / provider id, e.g. 'prometheus', 'loki', 'openai'. */
  adapterId: string;
  /** Operation name within the adapter, e.g. 'query', 'fetchMetadata'. */
  operation: string;
  /** HTTP status if the failure came from a response. */
  status?: number;
  /** Provider-specific error code from the upstream body. */
  providerCode?: string;
  /** Seconds the upstream asked us to wait. Retryable kinds only. */
  retryAfterSec?: number;
  /** Truncated upstream response body for diagnostics. */
  upstreamBody?: string;
  /** Raw underlying error — for logs only, never user-facing. */
  originalError?: unknown;
}

export class AdapterError extends Error {
  public readonly kind: AdapterErrorKind;
  public override readonly cause: AdapterErrorCause;

  constructor(kind: AdapterErrorKind, message: string, cause: AdapterErrorCause) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
    this.cause = cause;
  }

  /**
   * User-facing message — safe to render in chat / UI. Does NOT include the
   * adapter id, HTTP status, original error message, or stack trace.
   * Operational detail belongs in `cause` and the logs.
   */
  toUserMessage(): string {
    return userMessageForKind(this.kind);
  }
}

function userMessageForKind(kind: AdapterErrorKind): string {
  switch (kind) {
    case 'timeout':
      return 'The request took too long to complete. Please try again.';
    case 'dns_failure':
      return 'The data source could not be reached. Please check the connection settings.';
    case 'connection_refused':
      return 'The data source refused the connection. It may be offline.';
    case 'auth_failure':
      return 'Authentication with the data source failed. Please check your credentials.';
    case 'rate_limit':
      return 'The data source is rate-limiting requests. Please wait a moment and try again.';
    case 'not_found':
      return 'The requested resource was not found.';
    case 'bad_request':
      return 'The request was rejected. Please review the query and try again.';
    case 'server_error':
      return 'The data source is currently unavailable. Please try again shortly.';
    case 'malformed_response':
      return 'The data source returned an unexpected response.';
    case 'readonly':
      return 'This resource is read-only and cannot be modified.';
    case 'unknown':
    default:
      return 'An unexpected error occurred while contacting the data source.';
  }
}

/**
 * Classify an HTTP fetch failure into a canonical AdapterErrorKind. Covers the
 * common shapes: HTTP status, Node fetch error codes (ENOTFOUND / ECONNREFUSED
 * / ETIMEDOUT), AbortError. Specific adapters layer on top (e.g. readonly is
 * decided at the resource level, not from a status).
 */
export function classifyHttpError(opts: {
  status?: number;
  cause?: unknown;
}): AdapterErrorKind {
  const { status, cause } = opts;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth_failure';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limit';
    if (status === 400) return 'bad_request';
    if (status >= 500) return 'server_error';
    if (status >= 400) return 'bad_request';
  }
  const codes: string[] = [];
  const collect = (e: unknown) => {
    if (!e || typeof e !== 'object') return;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    const inner = (e as { cause?: unknown }).cause;
    if (inner) collect(inner);
  };
  collect(cause);
  if (codes.some((c) => /^(ENOTFOUND|EAI_AGAIN)$/i.test(c))) return 'dns_failure';
  if (codes.some((c) => /^(ECONNREFUSED|ECONNRESET)$/i.test(c))) return 'connection_refused';
  if (codes.some((c) => /^(ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET))$/i.test(c))) return 'timeout';
  if (cause instanceof Error && cause.name === 'AbortError') return 'timeout';
  if (cause instanceof Error && cause.name === 'TimeoutError') return 'timeout';
  if (cause instanceof Error && /timeout/i.test(cause.message)) return 'timeout';
  if (cause instanceof Error && /ENOTFOUND/i.test(cause.message)) return 'dns_failure';
  if (cause instanceof Error && /ECONNREFUSED/i.test(cause.message)) return 'connection_refused';
  // Undici / fetch's generic transport failure message. Classify as
  // connection_refused (the most retryable transport kind) so retry/fallback
  // logic that previously fired on this condition continues to fire.
  if (cause instanceof Error && /fetch failed|network|connection/i.test(cause.message)) {
    return 'connection_refused';
  }
  return 'unknown';
}

/**
 * Type guard for callers that want to branch on `AdapterError` without an
 * `instanceof` import.
 */
export function isAdapterError(err: unknown): err is AdapterError {
  return err instanceof AdapterError;
}
