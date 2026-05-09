/**
 * SQLite repository for the `llm_audit` table.
 *
 * Wraps the privacy-safe LLM call audit log written by `@agentic-obs/llm-gateway`'s
 * `AuditSink` interface. Privacy invariant: only token counts, timing, cost,
 * provider/model identifiers, and prompt sha256 are stored — never raw prompt
 * text or error message bodies.
 */

import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';

export type LlmAuditErrorKind =
  | 'timeout'
  | 'network'
  | 'ratelimit'
  | 'auth'
  | 'server'
  | 'aborted'
  | 'unknown';

export interface LlmAuditRecord {
  id: string;
  requestedAt: string;
  provider: string;
  model: string;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  success: boolean;
  errorKind: LlmAuditErrorKind | null;
  abortReason: string | null;
  orgId: string | null;
  userId: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface NewLlmAuditRecord {
  id: string;
  requestedAt: string;
  provider: string;
  model: string;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number | null;
  costUsd?: number | null;
  latencyMs: number;
  success: boolean;
  errorKind?: LlmAuditErrorKind | null;
  abortReason?: string | null;
  orgId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

export interface ILlmAuditRepository {
  insert(entry: NewLlmAuditRecord): Promise<void>;
  findById(id: string): Promise<LlmAuditRecord | null>;
  listRecent(limit?: number): Promise<LlmAuditRecord[]>;
}

interface Row {
  id: string;
  requested_at: string;
  provider: string;
  model: string;
  prompt_hash: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  success: number;
  error_kind: string | null;
  abort_reason: string | null;
  org_id: string | null;
  user_id: string | null;
  session_id: string | null;
  created_at: string;
}

function rowTo(r: Row): LlmAuditRecord {
  return {
    id: r.id,
    requestedAt: r.requested_at,
    provider: r.provider,
    model: r.model,
    promptHash: r.prompt_hash,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    cachedTokens: r.cached_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    success: r.success === 1,
    errorKind: (r.error_kind as LlmAuditErrorKind | null) ?? null,
    abortReason: r.abort_reason,
    orgId: r.org_id,
    userId: r.user_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

export class SqliteLlmAuditRepository implements ILlmAuditRepository {
  constructor(private readonly db: SqliteClient) {}

  async insert(e: NewLlmAuditRecord): Promise<void> {
    const createdAt = new Date().toISOString();
    this.db.run(sql`
      INSERT INTO llm_audit (
        id, requested_at, provider, model, prompt_hash,
        input_tokens, output_tokens, total_tokens, cached_tokens, cost_usd,
        latency_ms, success, error_kind, abort_reason,
        org_id, user_id, session_id, created_at
      ) VALUES (
        ${e.id}, ${e.requestedAt}, ${e.provider}, ${e.model}, ${e.promptHash},
        ${e.inputTokens}, ${e.outputTokens}, ${e.totalTokens},
        ${e.cachedTokens ?? null}, ${e.costUsd ?? null},
        ${e.latencyMs}, ${e.success ? 1 : 0},
        ${e.errorKind ?? null}, ${e.abortReason ?? null},
        ${e.orgId ?? null}, ${e.userId ?? null}, ${e.sessionId ?? null},
        ${createdAt}
      )
    `);
  }

  async findById(id: string): Promise<LlmAuditRecord | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM llm_audit WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listRecent(limit = 100): Promise<LlmAuditRecord[]> {
    const rows = this.db.all<Row>(sql`
      SELECT * FROM llm_audit ORDER BY requested_at DESC LIMIT ${limit}
    `);
    return rows.map(rowTo);
  }
}
