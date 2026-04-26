import { eq, count } from 'drizzle-orm';
import type { ChatMessage, DashboardAction } from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { chatMessages } from '../../db/sqlite-schema.js';
import type { IChatMessageRepository } from '../interfaces.js';

type DbRow = typeof chatMessages.$inferSelect;

function rowToMessage(row: DbRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as ChatMessage['role'],
    content: row.content,
    actions: (row.actions as DashboardAction[]) ?? undefined,
    timestamp: row.timestamp,
  };
}

export class SqliteChatMessageRepository implements IChatMessageRepository {
  constructor(private readonly db: SqliteClient) {}

  async addMessage(
    sessionId: string,
    message: { id: string; role: string; content: string; actions?: unknown; timestamp: string },
  ): Promise<ChatMessage> {
    const [row] = await this.db
      .insert(chatMessages)
      .values({
        id: message.id,
        sessionId,
        role: message.role,
        content: message.content,
        actions: (message.actions ?? null) as Record<string, unknown> | null,
        timestamp: message.timestamp,
      })
      .returning();
    return rowToMessage(row!);
  }

  async getMessages(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    let query = this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.timestamp);
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    const rows = await query;
    return rows.map(rowToMessage);
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    return row?.count ?? 0;
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.db.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId));
  }
}
