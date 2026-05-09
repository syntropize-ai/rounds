// Audit logger — records LLM call entries via a pluggable sink.
//
// The gateway calls an `AuditSink` after every LLM invocation (success or
// failure) with a structured entry. The default sink is an in-memory store
// that keeps the previous semantics for tests / one-off scripts. api-gateway
// builds a DB-backed sink at startup and injects it via `GatewayConfig`.
//
// PRIVACY INVARIANT: AuditEntry MUST NOT contain raw prompt text, raw user
// messages, tool outputs, API keys, or any other end-user content. Only:
//   - sha256(prompt JSON) as `promptHash`
//   - token counts, latency, cost
//   - provider/model identifiers
//   - org/user/session ids (caller-supplied)
//   - `errorKind` (enum) for failures — never the raw error message
// Anything else risks leaking secrets / PII into the audit table.

export type AuditErrorKind =
  | 'timeout'
  | 'network'
  | 'ratelimit'
  | 'auth'
  | 'server'
  | 'aborted'
  | 'unknown';

export interface AuditEntry {
  id: string;
  /** ISO-8601 timestamp of the request. */
  requestedAt: string;
  provider: string;
  model: string;
  /** sha256 of canonical messages JSON (full digest, NOT truncated). */
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number | null;
  /** USD cost. `null` when pricing for the model isn't known. */
  costUsd: number | null;
  latencyMs: number;
  success: boolean;
  /** Bucketed error class. `null` on success. */
  errorKind?: AuditErrorKind | null;
  abortReason?: string | null;
  orgId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

/**
 * Pluggable persistence sink. The default `InMemoryAuditSink` keeps entries
 * in process; api-gateway provides a DB-backed implementation at startup so
 * llm-gateway never directly imports data-layer.
 *
 * `record()` is intentionally `Promise<void>` — callers fire-and-forget and
 * implementations may batch / write asynchronously. Errors are swallowed by
 * the gateway so a sink failure never breaks an LLM call.
 */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
  /** Optional flush hook (used by batching sinks at shutdown). */
  flush?(): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  private entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  getEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  getEntriesByModel(model: string): AuditEntry[] {
    return this.entries.filter((e) => e.model === model);
  }

  getEntriesByProvider(provider: string): AuditEntry[] {
    return this.entries.filter((e) => e.provider === provider);
  }

  getTotalTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.totalTokens, 0);
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * @deprecated Renamed to `InMemoryAuditSink`. Kept as an alias so existing
 * tests / callers that reach into the gateway's in-memory sink keep working.
 */
export const AuditLogger = InMemoryAuditSink;
export type AuditLogger = InMemoryAuditSink;
