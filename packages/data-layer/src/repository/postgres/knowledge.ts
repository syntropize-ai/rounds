/**
 * KnowledgeRepository — Postgres-backed store for skill-style knowledge
 * entries. Mirrors sqlite/knowledge.ts. Corrupt intent_tags JSON throws.
 */

import { sql } from 'drizzle-orm';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { QueryClient } from '../../db/query-client.js';
import type {
  IKnowledgeRepository,
  KnowledgeEntry,
} from '../interfaces.js';
import { pgAll, pgRun } from './pg-helpers.js';

const log = createLogger('postgres-knowledge-repository');

interface KnowledgeRow {
  id: string;
  org_id: string;
  source: string;
  source_ref: string | null;
  title: string;
  description: string;
  body: string;
  intent_tags: string;
  use_count: number;
  approved_count: number;
  rejected_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseIntentTags(raw: string, rowId: string): string[] {
  if (Array.isArray(raw)) return raw as string[];
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    log.error(
      { rowId, err: err instanceof Error ? err.message : String(err) },
      'corrupt JSON in knowledge_entries.intent_tags — refusing to return fallback',
    );
    throw new Error(
      `[KnowledgeRepository] corrupt JSON in column "intent_tags" for row ${rowId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    log.error(
      { rowId, actualType: typeof parsed },
      'knowledge_entries.intent_tags is not an array — refusing to return fallback',
    );
    throw new Error(
      `[KnowledgeRepository] expected array in column "intent_tags" for row ${rowId}, got ${typeof parsed}`,
    );
  }
  return parsed as string[];
}

function rowToEntry(r: KnowledgeRow): KnowledgeEntry {
  return {
    id: r.id,
    orgId: r.org_id,
    source: r.source as KnowledgeEntry['source'],
    sourceRef: r.source_ref,
    title: r.title,
    description: r.description,
    body: r.body,
    intentTags: parseIntentTags(r.intent_tags, r.id),
    useCount: Number(r.use_count),
    approvedCount: Number(r.approved_count),
    rejectedCount: Number(r.rejected_count),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class PostgresKnowledgeRepository implements IKnowledgeRepository {
  constructor(private readonly db: QueryClient) {}

  async insert(
    input: Omit<
      KnowledgeEntry,
      'createdAt' | 'updatedAt' | 'useCount' | 'approvedCount' | 'rejectedCount'
    >,
  ): Promise<KnowledgeEntry> {
    const now = nowIso();
    await pgRun(
      this.db,
      sql`
        INSERT INTO knowledge_entries (
          id, org_id, source, source_ref, title, description, body,
          intent_tags,
          use_count, approved_count, rejected_count,
          created_by, created_at, updated_at
        ) VALUES (
          ${input.id},
          ${input.orgId},
          ${input.source},
          ${input.sourceRef},
          ${input.title},
          ${input.description},
          ${input.body},
          ${JSON.stringify(input.intentTags)},
          ${0},
          ${0},
          ${0},
          ${input.createdBy},
          ${now},
          ${now}
        )
      `,
    );
    const saved = await this.getById(input.orgId, input.id);
    if (!saved) {
      throw new Error(
        `[KnowledgeRepository] insert: row ${input.id} not found after insert`,
      );
    }
    return saved;
  }

  async getById(orgId: string, id: string): Promise<KnowledgeEntry | null> {
    const rows = await pgAll<KnowledgeRow>(
      this.db,
      sql`SELECT * FROM knowledge_entries WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`,
    );
    if (rows.length === 0) return null;
    return rowToEntry(rows[0]!);
  }

  async list(
    orgId: string,
    opts?: { source?: KnowledgeEntry['source']; limit?: number },
  ): Promise<KnowledgeEntry[]> {
    const source = opts?.source;
    const limit = opts?.limit;
    let rows: KnowledgeRow[];
    if (source !== undefined && limit !== undefined) {
      rows = await pgAll<KnowledgeRow>(this.db, sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND source = ${source}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
    } else if (source !== undefined) {
      rows = await pgAll<KnowledgeRow>(this.db, sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND source = ${source}
        ORDER BY created_at DESC
      `);
    } else if (limit !== undefined) {
      rows = await pgAll<KnowledgeRow>(this.db, sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
    } else {
      rows = await pgAll<KnowledgeRow>(this.db, sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
      `);
    }
    return rows.map(rowToEntry);
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<
      Pick<
        KnowledgeEntry,
        'title' | 'description' | 'body' | 'intentTags' | 'sourceRef'
      >
    >,
  ): Promise<KnowledgeEntry | null> {
    const existing = await this.getById(orgId, id);
    if (!existing) return null;
    const next = {
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      body: patch.body ?? existing.body,
      intentTags: patch.intentTags ?? existing.intentTags,
      sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : existing.sourceRef,
    };
    const now = nowIso();
    await pgRun(this.db, sql`
      UPDATE knowledge_entries
      SET title = ${next.title},
          description = ${next.description},
          body = ${next.body},
          intent_tags = ${JSON.stringify(next.intentTags)},
          source_ref = ${next.sourceRef},
          updated_at = ${now}
      WHERE org_id = ${orgId} AND id = ${id}
    `);
    return this.getById(orgId, id);
  }

  async bumpUseCount(orgId: string, id: string): Promise<void> {
    const now = nowIso();
    await pgRun(this.db, sql`
      UPDATE knowledge_entries
      SET use_count = use_count + 1, updated_at = ${now}
      WHERE org_id = ${orgId} AND id = ${id}
    `);
  }

  async recordFeedback(
    orgId: string,
    id: string,
    approved: boolean,
  ): Promise<void> {
    const now = nowIso();
    if (approved) {
      await pgRun(this.db, sql`
        UPDATE knowledge_entries
        SET approved_count = approved_count + 1, updated_at = ${now}
        WHERE org_id = ${orgId} AND id = ${id}
      `);
    } else {
      await pgRun(this.db, sql`
        UPDATE knowledge_entries
        SET rejected_count = rejected_count + 1, updated_at = ${now}
        WHERE org_id = ${orgId} AND id = ${id}
      `);
    }
  }

  async delete(orgId: string, id: string): Promise<void> {
    await pgRun(
      this.db,
      sql`DELETE FROM knowledge_entries WHERE org_id = ${orgId} AND id = ${id}`,
    );
  }

  async listForSearch(
    orgId: string,
    opts?: { source?: KnowledgeEntry['source']; limit?: number },
  ): Promise<KnowledgeEntry[]> {
    return this.list(orgId, opts);
  }
}
