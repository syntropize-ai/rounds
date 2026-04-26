// DataAdapter interface - the contract every data source adapter must fulfill

import type {
  Capabilities,
  SemanticQuery,
  StructuredResult,
  StreamSubscription,
  EventStream,
  AdapterHealth,
} from './types.js';

// -- AdapterError --------------------------------------------------------
//
// Typed error raised by adapter integration boundaries (HTTP fetch against
// Prometheus / Loki / etc.) when the underlying datasource fails. Callers
// branch on `kind`:
//
//   - 'unreachable' : transport-level failure (DNS, connection refused,
//                     timeout) or 5xx server errors.
//   - 'auth'        : credentials rejected (401/403).
//   - 'malformed'   : 200 response with unparseable / invalid body.
//   - 'unknown'     : everything else (4xx besides 401/403, novel errors).

export type AdapterErrorKind = 'unreachable' | 'auth' | 'malformed' | 'unknown';

export class AdapterError extends Error {
  public readonly kind: AdapterErrorKind;
  public readonly adapter: string;
  public readonly status?: number;
  public override readonly cause?: unknown;

  constructor(
    message: string,
    opts: {
      kind: AdapterErrorKind;
      adapter: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'AdapterError';
    this.kind = opts.kind;
    this.adapter = opts.adapter;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Classify an HTTP fetch failure into an AdapterErrorKind. Keep in sync with
 * the equivalent helper in `@agentic-obs/llm-gateway` — the buckets differ
 * (adapters use 'unreachable' / 'malformed' instead of 'network' /
 * 'unsupported') but the inputs are the same.
 */
export function classifyAdapterHttpError(opts: {
  status?: number;
  cause?: unknown;
}): AdapterErrorKind {
  const { status, cause } = opts;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth';
    if (status >= 500) return 'unreachable';
    if (status >= 400) return 'unknown';
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
  if (codes.some((c) => /^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET))$/i.test(c))) {
    return 'unreachable';
  }
  if (cause instanceof Error && cause.name === 'AbortError') return 'unreachable';
  return 'unknown';
}

export interface DataAdapter {
  /** Unique identifier for this adapter instance (e.g. "prometheus-prod") */
  readonly name: string;
  /** Human-readable description */
  readonly description?: string;

  /** Declare what this adapter can provide */
  meta(): Capabilities;

  /**
   * Execute a semantic query and return a structured result.
   * Adapters must translate the SemanticQuery into their native query language.
   */
  query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;

  /**
   * Open a live stream for the given subscription.
   * Optional - adapters that do not support streaming may omit this.
   */
  stream?<T = unknown>(subscription: StreamSubscription): EventStream<T>;

  /** Check whether the underlying data source is reachable and healthy. */
  healthCheck(): Promise<AdapterHealth>;
}