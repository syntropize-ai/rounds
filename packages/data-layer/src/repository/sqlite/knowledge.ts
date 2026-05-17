/**
 * KnowledgeRepository — SQLite-backed store for the knowledge base
 * foundation (B1).
 *
 * Backs the `knowledge_entries` table. JSON columns (`intent_tags`,
 * `content`) are stored as TEXT and serialized at this layer. Corrupt
 * JSON throws — there is no silent fallback. Style mirrors
 * sqlite/dashboard.ts.
 */

import { sql } from 'drizzle-orm';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type {
  IKnowledgeRepository,
  KnowledgeEntry,
} from '../interfaces.js';
import { nowIso } from './instance-shared.js';

const log = createLogger('knowledge-repository');

interface KnowledgeRow {
  id: string;
  org_id: string;
  source: string;
  source_ref: string | null;
  kind: string;
  title: string;
  intent_tags: string;
  content: string;
  use_count: number;
  approved_count: number;
  rejected_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonColumn(raw: string, rowId: string, column: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.error(
      { rowId, column, err: err instanceof Error ? err.message : String(err) },
      'corrupt JSON in knowledge_entries row — refusing to return fallback',
    );
    throw new Error(
      `[KnowledgeRepository] corrupt JSON in column "${column}" for row ${rowId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function rowToEntry(r: KnowledgeRow): KnowledgeEntry {
  const tagsParsed = parseJsonColumn(r.intent_tags, r.id, 'intent_tags');
  if (!Array.isArray(tagsParsed)) {
    log.error(
      { rowId: r.id, column: 'intent_tags', actualType: typeof tagsParsed },
      'knowledge_entries.intent_tags is not an array — refusing to return fallback',
    );
    throw new Error(
      `[KnowledgeRepository] expected array in column "intent_tags" for row ${r.id}, got ${typeof tagsParsed}`,
    );
  }
  const content = parseJsonColumn(r.content, r.id, 'content');
  return {
    id: r.id,
    orgId: r.org_id,
    source: r.source as KnowledgeEntry['source'],
    sourceRef: r.source_ref,
    kind: r.kind as KnowledgeEntry['kind'],
    title: r.title,
    intentTags: tagsParsed as string[],
    content,
    useCount: r.use_count,
    approvedCount: r.approved_count,
    rejectedCount: r.rejected_count,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SqliteKnowledgeRepository implements IKnowledgeRepository {
  constructor(private readonly db: SqliteClient) {}

  async insert(
    input: Omit<
      KnowledgeEntry,
      'createdAt' | 'updatedAt' | 'useCount' | 'approvedCount' | 'rejectedCount'
    >,
  ): Promise<KnowledgeEntry> {
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO knowledge_entries (
        id, org_id, source, source_ref, kind, title,
        intent_tags, content,
        use_count, approved_count, rejected_count,
        created_by, created_at, updated_at
      ) VALUES (
        ${input.id},
        ${input.orgId},
        ${input.source},
        ${input.sourceRef},
        ${input.kind},
        ${input.title},
        ${JSON.stringify(input.intentTags)},
        ${JSON.stringify(input.content)},
        ${0},
        ${0},
        ${0},
        ${input.createdBy},
        ${now},
        ${now}
      )
    `);
    const saved = await this.getById(input.orgId, input.id);
    if (!saved) {
      throw new Error(
        `[KnowledgeRepository] insert: row ${input.id} not found after insert`,
      );
    }
    return saved;
  }

  async getById(orgId: string, id: string): Promise<KnowledgeEntry | null> {
    const rows = this.db.all<KnowledgeRow>(
      sql`SELECT * FROM knowledge_entries WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`,
    );
    if (rows.length === 0) return null;
    return rowToEntry(rows[0]!);
  }

  async list(
    orgId: string,
    opts?: {
      kind?: KnowledgeEntry['kind'];
      source?: KnowledgeEntry['source'];
      limit?: number;
    },
  ): Promise<KnowledgeEntry[]> {
    const kind = opts?.kind;
    const source = opts?.source;
    const limit = opts?.limit;
    let rows: KnowledgeRow[];
    if (kind !== undefined && source !== undefined && limit !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND kind = ${kind} AND source = ${source}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
    } else if (kind !== undefined && source !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND kind = ${kind} AND source = ${source}
        ORDER BY created_at DESC
      `);
    } else if (kind !== undefined && limit !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND kind = ${kind}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
    } else if (source !== undefined && limit !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND source = ${source}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
    } else if (kind !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND kind = ${kind}
        ORDER BY created_at DESC
      `);
    } else if (source !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId} AND source = ${source}
        ORDER BY created_at DESC
      `);
    } else if (limit !== undefined) {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
    } else {
      rows = this.db.all<KnowledgeRow>(sql`
        SELECT * FROM knowledge_entries
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
      `);
    }
    return rows.map(rowToEntry);
  }

  async bumpUseCount(orgId: string, id: string): Promise<void> {
    const now = nowIso();
    this.db.run(sql`
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
      this.db.run(sql`
        UPDATE knowledge_entries
        SET approved_count = approved_count + 1, updated_at = ${now}
        WHERE org_id = ${orgId} AND id = ${id}
      `);
    } else {
      this.db.run(sql`
        UPDATE knowledge_entries
        SET rejected_count = rejected_count + 1, updated_at = ${now}
        WHERE org_id = ${orgId} AND id = ${id}
      `);
    }
  }

  async delete(orgId: string, id: string): Promise<void> {
    this.db.run(
      sql`DELETE FROM knowledge_entries WHERE org_id = ${orgId} AND id = ${id}`,
    );
  }

  async listForSearch(
    orgId: string,
    opts?: { kind?: KnowledgeEntry['kind'] },
  ): Promise<KnowledgeEntry[]> {
    const rows =
      opts?.kind === undefined
        ? this.db.all<KnowledgeRow>(
            sql`SELECT * FROM knowledge_entries WHERE org_id = ${orgId} ORDER BY created_at DESC`,
          )
        : this.db.all<KnowledgeRow>(
            sql`SELECT * FROM knowledge_entries WHERE org_id = ${orgId} AND kind = ${opts.kind} ORDER BY created_at DESC`,
          );
    return rows.map(rowToEntry);
  }
}
