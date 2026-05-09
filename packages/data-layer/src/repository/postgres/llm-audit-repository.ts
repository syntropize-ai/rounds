/**
 * Postgres repository for the `llm_audit` table.
 *
 * Mirrors the SQLite implementation at
 * `../sqlite/llm-audit-repository.ts`. See that file for the privacy contract:
 * never store raw prompt text, error message bodies, or end-user content —
 * only sha256 prompt hash, token counts, latency, cost, and bucketed error
 * kind.
 */

import { sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import type {
  ILlmAuditRepository,
  LlmAuditRecord,
  LlmAuditErrorKind,
  NewLlmAuditRecord,
} from '../sqlite/llm-audit-repository.js';

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
  cost_usd: number | string | null;
  latency_ms: number;
  success: boolean;
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
    // pg returns DOUBLE PRECISION as number, but be defensive in case the
    // driver flips it to string for very large values.
    costUsd: r.cost_usd === null ? null : typeof r.cost_usd === 'string' ? Number(r.cost_usd) : r.cost_usd,
    latencyMs: r.latency_ms,
    success: r.success,
    errorKind: (r.error_kind as LlmAuditErrorKind | null) ?? null,
    abortReason: r.abort_reason,
    orgId: r.org_id,
    userId: r.user_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

export class PostgresLlmAuditRepository implements ILlmAuditRepository {
  constructor(private readonly db: DbClient) {}

  async insert(e: NewLlmAuditRecord): Promise<void> {
    const createdAt = new Date().toISOString();
    await this.db.run(sql`
      INSERT INTO llm_audit (
        id, requested_at, provider, model, prompt_hash,
        input_tokens, output_tokens, total_tokens, cached_tokens, cost_usd,
        latency_ms, success, error_kind, abort_reason,
        org_id, user_id, session_id, created_at
      ) VALUES (
        ${e.id}, ${e.requestedAt}, ${e.provider}, ${e.model}, ${e.promptHash},
        ${e.inputTokens}, ${e.outputTokens}, ${e.totalTokens},
        ${e.cachedTokens ?? null}, ${e.costUsd ?? null},
        ${e.latencyMs}, ${e.success},
        ${e.errorKind ?? null}, ${e.abortReason ?? null},
        ${e.orgId ?? null}, ${e.userId ?? null}, ${e.sessionId ?? null},
        ${createdAt}
      )
    `);
  }

  async findById(id: string): Promise<LlmAuditRecord | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM llm_audit WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listRecent(limit = 100): Promise<LlmAuditRecord[]> {
    const rows = await this.db.all<Row>(sql`
      SELECT * FROM llm_audit ORDER BY requested_at DESC LIMIT ${limit}
    `);
    return rows.map(rowTo);
  }
}
