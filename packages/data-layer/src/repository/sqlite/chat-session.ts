import { and, eq, desc } from 'drizzle-orm';
import type { ChatSession } from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { chatSessions } from '../../db/sqlite-schema.js';
import type {
  ChatSessionScope,
  IChatSessionRepository,
} from '../interfaces.js';

type DbRow = typeof chatSessions.$inferSelect;

function rowToSession(row: DbRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    orgId: row.orgId,
    ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.contextSummary ? { contextSummary: row.contextSummary } : {}),
  };
}

function sessionWhere(id: string, scope: ChatSessionScope = {}) {
  return and(
    eq(chatSessions.id, id),
    scope.orgId ? eq(chatSessions.orgId, scope.orgId) : undefined,
    scope.ownerUserId
      ? eq(chatSessions.ownerUserId, scope.ownerUserId)
      : undefined,
  );
}

function scopeWhere(scope: ChatSessionScope = {}) {
  return and(
    scope.orgId ? eq(chatSessions.orgId, scope.orgId) : undefined,
    scope.ownerUserId
      ? eq(chatSessions.ownerUserId, scope.ownerUserId)
      : undefined,
  );
}

export class SqliteChatSessionRepository implements IChatSessionRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(session: {
    id: string;
    title?: string;
    orgId?: string;
    ownerUserId?: string;
  }): Promise<ChatSession> {
    const now = new Date().toISOString();
    const [row] = await this.db
      .insert(chatSessions)
      .values({
        id: session.id,
        title: session.title ?? '',
        orgId: session.orgId ?? 'org_main',
        ownerUserId: session.ownerUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToSession(row!);
  }

  async findById(
    id: string,
    scope: ChatSessionScope = {},
  ): Promise<ChatSession | undefined> {
    const [row] = await this.db
      .select()
      .from(chatSessions)
      .where(sessionWhere(id, scope));
    return row ? rowToSession(row) : undefined;
  }

  async findAll(
    limit = 50,
    scope: ChatSessionScope = {},
  ): Promise<ChatSession[]> {
    const base = this.db.select().from(chatSessions);
    const where = scopeWhere(scope);
    const rows = where
      ? await base
          .where(where)
          .orderBy(desc(chatSessions.updatedAt))
          .limit(limit)
      : await base.orderBy(desc(chatSessions.updatedAt)).limit(limit);
    return rows.map(rowToSession);
  }

  async updateTitle(
    id: string,
    title: string,
    scope: ChatSessionScope = {},
  ): Promise<ChatSession | undefined> {
    const [row] = await this.db
      .update(chatSessions)
      .set({ title, updatedAt: new Date().toISOString() })
      .where(sessionWhere(id, scope))
      .returning();
    return row ? rowToSession(row) : undefined;
  }

  async updateContextSummary(
    id: string,
    summary: string,
    scope: ChatSessionScope = {},
  ): Promise<ChatSession | undefined> {
    const [row] = await this.db
      .update(chatSessions)
      .set({ contextSummary: summary, updatedAt: new Date().toISOString() })
      .where(sessionWhere(id, scope))
      .returning();
    return row ? rowToSession(row) : undefined;
  }

  async delete(id: string, scope: ChatSessionScope = {}): Promise<boolean> {
    const result = await this.db
      .delete(chatSessions)
      .where(sessionWhere(id, scope))
      .returning();
    return result.length > 0;
  }
}
