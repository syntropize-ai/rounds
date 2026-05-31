import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Identity } from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { chatMessageQueue } from '../../db/sqlite-schema.js';
import type {
  ChatQueuedMessage,
  ChatQueuedMessageStatus,
  IChatMessageQueueRepository,
} from '../interfaces.js';

type DbRow = typeof chatMessageQueue.$inferSelect;

function rowToQueuedMessage(row: DbRow): ChatQueuedMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    orgId: row.orgId,
    ownerUserId: row.ownerUserId,
    content: row.content,
    pageContext: (row.pageContext as Record<string, unknown> | null) ?? null,
    identity: row.identity as Identity,
    status: row.status as ChatQueuedMessageStatus,
    position: row.position,
    runId: row.runId,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export class SqliteChatMessageQueueRepository implements IChatMessageQueueRepository {
  constructor(private readonly db: SqliteClient) {}

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
      const db = tx as unknown as SqliteClient;
      const existing = await db
        .select()
        .from(chatMessageQueue)
        .where(eq(chatMessageQueue.sessionId, input.sessionId))
        .orderBy(desc(chatMessageQueue.position))
        .limit(1);
      const position = (existing[0]?.position ?? 0) + 1;
      const [row] = await db
        .insert(chatMessageQueue)
        .values({
          id: input.id ?? randomUUID(),
          sessionId: input.sessionId,
          orgId: input.orgId,
          ownerUserId: input.ownerUserId,
          content: input.content,
          pageContext: input.pageContext ?? null,
          identity: input.identity as unknown as Record<string, unknown>,
          status: 'queued',
          position,
          createdAt: input.createdAt ?? new Date().toISOString(),
        })
        .returning();
      return rowToQueuedMessage(row!);
    });
  }

  async claimNext(sessionId: string): Promise<ChatQueuedMessage | null> {
    return this.db.withTransaction(async (tx) => {
      const db = tx as unknown as SqliteClient;
      const rows = await db
        .select()
        .from(chatMessageQueue)
        .where(and(eq(chatMessageQueue.sessionId, sessionId), eq(chatMessageQueue.status, 'queued')))
        .orderBy(asc(chatMessageQueue.position))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const now = new Date().toISOString();
      const [claimed] = await db
        .update(chatMessageQueue)
        .set({ status: 'running', startedAt: now })
        .where(and(eq(chatMessageQueue.id, row.id), eq(chatMessageQueue.status, 'queued')))
        .returning();
      return claimed ? rowToQueuedMessage(claimed) : null;
    });
  }

  async markRunning(id: string, runId: string, startedAt = new Date().toISOString()): Promise<ChatQueuedMessage | null> {
    const [row] = await this.db
      .update(chatMessageQueue)
      .set({ status: 'running', runId, startedAt })
      .where(eq(chatMessageQueue.id, id))
      .returning();
    return row ? rowToQueuedMessage(row) : null;
  }

  async updateQueuedContent(id: string, content: string): Promise<ChatQueuedMessage | null> {
    const [row] = await this.db
      .update(chatMessageQueue)
      .set({ content })
      .where(and(eq(chatMessageQueue.id, id), eq(chatMessageQueue.status, 'queued')))
      .returning();
    return row ? rowToQueuedMessage(row) : null;
  }

  async deleteQueued(id: string): Promise<ChatQueuedMessage | null> {
    return this.db.withTransaction(async (tx) => {
      const db = tx as unknown as SqliteClient;
      const rows = await db
        .select()
        .from(chatMessageQueue)
        .where(and(eq(chatMessageQueue.id, id), eq(chatMessageQueue.status, 'queued')))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      await db.delete(chatMessageQueue).where(eq(chatMessageQueue.id, id));
      return rowToQueuedMessage(row);
    });
  }

  async markSucceeded(id: string, completedAt = new Date().toISOString()): Promise<ChatQueuedMessage | null> {
    const [row] = await this.db
      .update(chatMessageQueue)
      .set({ status: 'succeeded', completedAt })
      .where(eq(chatMessageQueue.id, id))
      .returning();
    return row ? rowToQueuedMessage(row) : null;
  }

  async markFailed(
    id: string,
    errorMessage: string,
    completedAt = new Date().toISOString(),
  ): Promise<ChatQueuedMessage | null> {
    const [row] = await this.db
      .update(chatMessageQueue)
      .set({ status: 'failed', errorMessage: errorMessage.slice(0, 500), completedAt })
      .where(eq(chatMessageQueue.id, id))
      .returning();
    return row ? rowToQueuedMessage(row) : null;
  }

  async cancelQueuedBySession(sessionId: string, completedAt = new Date().toISOString()): Promise<number> {
    const rows = await this.db
      .update(chatMessageQueue)
      .set({ status: 'canceled', completedAt })
      .where(and(eq(chatMessageQueue.sessionId, sessionId), eq(chatMessageQueue.status, 'queued')))
      .returning();
    return rows.length;
  }

  async listBySession(sessionId: string): Promise<ChatQueuedMessage[]> {
    const rows = await this.db
      .select()
      .from(chatMessageQueue)
      .where(eq(chatMessageQueue.sessionId, sessionId))
      .orderBy(asc(chatMessageQueue.position));
    return rows.map(rowToQueuedMessage);
  }
}
