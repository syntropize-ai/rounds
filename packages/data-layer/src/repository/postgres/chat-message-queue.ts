import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Identity } from '@agentic-obs/common';
import type { DbClient } from '../../db/client.js';
import type {
  ChatQueuedMessage,
  ChatQueuedMessageStatus,
  IChatMessageQueueRepository,
} from '../interfaces.js';

interface QueueRow {
  id: string;
  session_id: string;
  org_id: string;
  owner_user_id: string;
  content: string;
  page_context: unknown | null;
  identity: unknown;
  status: string;
  position: number;
  run_id: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToQueuedMessage(row: QueueRow): ChatQueuedMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    content: row.content,
    pageContext: (row.page_context as Record<string, unknown> | null) ?? null,
    identity: row.identity as Identity,
    status: row.status as ChatQueuedMessageStatus,
    position: Number(row.position),
    runId: row.run_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class PostgresChatMessageQueueRepository implements IChatMessageQueueRepository {
  constructor(private readonly db: DbClient) {}

  async enqueue(input: {
    id?: string;
    sessionId: string;
    orgId: string;
    ownerUserId: string;
    content: string;
    pageContext?: Record<string, unknown> | null;
    identity: Identity;
    createdAt?: string;
  }): Promise<ChatQueuedMessage> {
    return this.db.withTransaction(async (tx) => {
      await tx.run(sql`SELECT pg_advisory_xact_lock(hashtext(${input.sessionId}))`);
      const rows = await tx.all<{ position: number | null }>(sql`
        SELECT COALESCE(MAX(position), 0)::int AS position
        FROM chat_message_queue
        WHERE session_id = ${input.sessionId}
      `);
      const position = Number(rows[0]?.position ?? 0) + 1;
      const id = input.id ?? randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const inserted = await tx.all<QueueRow>(sql`
        INSERT INTO chat_message_queue (
          id, session_id, org_id, owner_user_id, content, page_context, identity,
          status, position, run_id, error_message, created_at, started_at, completed_at
        ) VALUES (
          ${id}, ${input.sessionId}, ${input.orgId}, ${input.ownerUserId}, ${input.content},
          ${JSON.stringify(input.pageContext ?? null)}::jsonb,
          ${JSON.stringify(input.identity)}::jsonb,
          'queued', ${position}, NULL, NULL, ${createdAt}, NULL, NULL
        )
        RETURNING *
      `);
      return rowToQueuedMessage(inserted[0]!);
    });
  }

  async claimNext(sessionId: string): Promise<ChatQueuedMessage | null> {
    return this.db.withTransaction(async (tx) => {
      await tx.run(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
      const rows = await tx.all<QueueRow>(sql`
        UPDATE chat_message_queue
        SET status = 'running', started_at = ${new Date().toISOString()}
        WHERE id = (
          SELECT id FROM chat_message_queue
          WHERE session_id = ${sessionId} AND status = 'queued'
          ORDER BY position ASC
          LIMIT 1
        )
        RETURNING *
      `);
      return rows[0] ? rowToQueuedMessage(rows[0]) : null;
    });
  }

  async markRunning(id: string, runId: string, startedAt = new Date().toISOString()): Promise<ChatQueuedMessage | null> {
    const rows = await this.db.all<QueueRow>(sql`
      UPDATE chat_message_queue
      SET status = 'running', run_id = ${runId}, started_at = ${startedAt}
      WHERE id = ${id}
      RETURNING *
    `);
    return rows[0] ? rowToQueuedMessage(rows[0]) : null;
  }

  async updateQueuedContent(id: string, content: string): Promise<ChatQueuedMessage | null> {
    const rows = await this.db.all<QueueRow>(sql`
      UPDATE chat_message_queue
      SET content = ${content}
      WHERE id = ${id} AND status = 'queued'
      RETURNING *
    `);
    return rows[0] ? rowToQueuedMessage(rows[0]) : null;
  }

  async deleteQueued(id: string): Promise<ChatQueuedMessage | null> {
    return this.db.withTransaction(async (tx) => {
      const rows = await tx.all<QueueRow>(sql`
        DELETE FROM chat_message_queue
        WHERE id = ${id} AND status = 'queued'
        RETURNING *
      `);
      return rows[0] ? rowToQueuedMessage(rows[0]) : null;
    });
  }

  async markSucceeded(id: string, completedAt = new Date().toISOString()): Promise<ChatQueuedMessage | null> {
    const rows = await this.db.all<QueueRow>(sql`
      UPDATE chat_message_queue
      SET status = 'succeeded', completed_at = ${completedAt}
      WHERE id = ${id}
      RETURNING *
    `);
    return rows[0] ? rowToQueuedMessage(rows[0]) : null;
  }

  async markFailed(
    id: string,
    errorMessage: string,
    completedAt = new Date().toISOString(),
  ): Promise<ChatQueuedMessage | null> {
    const rows = await this.db.all<QueueRow>(sql`
      UPDATE chat_message_queue
      SET status = 'failed', error_message = ${errorMessage.slice(0, 500)}, completed_at = ${completedAt}
      WHERE id = ${id}
      RETURNING *
    `);
    return rows[0] ? rowToQueuedMessage(rows[0]) : null;
  }

  async cancelQueuedBySession(sessionId: string, completedAt = new Date().toISOString()): Promise<number> {
    const rows = await this.db.all<{ id: string }>(sql`
      UPDATE chat_message_queue
      SET status = 'canceled', completed_at = ${completedAt}
      WHERE session_id = ${sessionId} AND status = 'queued'
      RETURNING id
    `);
    return rows.length;
  }

  async listBySession(sessionId: string): Promise<ChatQueuedMessage[]> {
    const rows = await this.db.all<QueueRow>(sql`
      SELECT * FROM chat_message_queue
      WHERE session_id = ${sessionId}
      ORDER BY position ASC
    `);
    return rows.map(rowToQueuedMessage);
  }

}
