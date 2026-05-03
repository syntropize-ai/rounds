import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { ChatSessionContext } from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { chatSessionContexts } from '../../db/sqlite-schema.js';
import type {
  ChatSessionContextResourceScope,
  ChatSessionScope,
  IChatSessionContextRepository,
} from '../interfaces.js';

type DbRow = typeof chatSessionContexts.$inferSelect;

function rowToContext(row: DbRow): ChatSessionContext {
  return {
    id: row.id,
    sessionId: row.sessionId,
    orgId: row.orgId,
    ownerUserId: row.ownerUserId,
    resourceType: row.resourceType as ChatSessionContext['resourceType'],
    resourceId: row.resourceId,
    relation: row.relation as ChatSessionContext['relation'],
    createdAt: row.createdAt,
  };
}

function sessionWhere(sessionId: string, scope: ChatSessionScope = {}) {
  return and(
    eq(chatSessionContexts.sessionId, sessionId),
    scope.orgId ? eq(chatSessionContexts.orgId, scope.orgId) : undefined,
    scope.ownerUserId
      ? eq(chatSessionContexts.ownerUserId, scope.ownerUserId)
      : undefined,
  );
}

function resourceWhere(scope: ChatSessionContextResourceScope) {
  return and(
    eq(chatSessionContexts.resourceType, scope.resourceType),
    eq(chatSessionContexts.resourceId, scope.resourceId),
    scope.orgId ? eq(chatSessionContexts.orgId, scope.orgId) : undefined,
    scope.ownerUserId
      ? eq(chatSessionContexts.ownerUserId, scope.ownerUserId)
      : undefined,
  );
}

function contextUniqueWhere(context: Parameters<IChatSessionContextRepository['create']>[0]) {
  return and(
    eq(chatSessionContexts.sessionId, context.sessionId),
    eq(chatSessionContexts.orgId, context.orgId),
    eq(chatSessionContexts.ownerUserId, context.ownerUserId),
    eq(chatSessionContexts.resourceType, context.resourceType),
    eq(chatSessionContexts.resourceId, context.resourceId),
    eq(chatSessionContexts.relation, context.relation),
  );
}

function isDuplicateKeyError(err: unknown): boolean {
  const cause = err && typeof err === 'object' && 'cause' in err ? (err as { cause?: unknown }).cause : undefined;
  const message = `${String(err)} ${String(cause)}`.toLowerCase();
  return message.includes('unique constraint failed') || message.includes('constraint_unique');
}

export class SqliteChatSessionContextRepository implements IChatSessionContextRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(
    context: Parameters<IChatSessionContextRepository['create']>[0],
  ): Promise<ChatSessionContext> {
    try {
      const [row] = await this.db
        .insert(chatSessionContexts)
        .values({
          id: context.id ?? `chatctx_${randomUUID()}`,
          sessionId: context.sessionId,
          orgId: context.orgId,
          ownerUserId: context.ownerUserId,
          resourceType: context.resourceType,
          resourceId: context.resourceId,
          relation: context.relation,
          createdAt: context.createdAt ?? new Date().toISOString(),
        })
        .returning();
      return rowToContext(row!);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const [existing] = await this.db
        .select()
        .from(chatSessionContexts)
        .where(contextUniqueWhere(context));
      if (existing) return rowToContext(existing);
      throw err;
    }
  }

  async listBySession(
    sessionId: string,
    scope: ChatSessionScope = {},
  ): Promise<ChatSessionContext[]> {
    const rows = await this.db
      .select()
      .from(chatSessionContexts)
      .where(sessionWhere(sessionId, scope))
      .orderBy(desc(chatSessionContexts.createdAt));
    return rows.map(rowToContext);
  }

  async listByResource(
    scope: ChatSessionContextResourceScope,
    limit = 50,
  ): Promise<ChatSessionContext[]> {
    const rows = await this.db
      .select()
      .from(chatSessionContexts)
      .where(resourceWhere(scope))
      .orderBy(desc(chatSessionContexts.createdAt))
      .limit(limit);
    return rows.map(rowToContext);
  }

  async deleteBySession(
    sessionId: string,
    scope: ChatSessionScope = {},
  ): Promise<void> {
    await this.db
      .delete(chatSessionContexts)
      .where(sessionWhere(sessionId, scope));
  }
}
