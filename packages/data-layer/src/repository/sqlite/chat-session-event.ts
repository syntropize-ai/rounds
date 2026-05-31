import { and, asc, desc, eq, max } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { chatSessionEvents } from '../../db/sqlite-schema.js';
import type {
  ChatSessionEventRecord,
  IChatSessionEventRepository,
} from '../interfaces.js';

type DbRow = typeof chatSessionEvents.$inferSelect;

function rowToEvent(row: DbRow): ChatSessionEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    kind: row.kind,
    payload: (row.payload as Record<string, unknown>) ?? {},
    timestamp: row.timestamp,
  };
}

export class SqliteChatSessionEventRepository implements IChatSessionEventRepository {
  constructor(private readonly db: SqliteClient) {}

  async append(event: ChatSessionEventRecord): Promise<void> {
    await this.db.insert(chatSessionEvents).values({
      id: event.id,
      sessionId: event.sessionId,
      seq: event.seq,
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
      timestamp: event.timestamp,
    });
  }

  async appendNext(
    event: Omit<ChatSessionEventRecord, 'seq'>,
  ): Promise<ChatSessionEventRecord> {
    return this.db.withTransaction(async (tx) => {
      const db = tx as unknown as SqliteClient;
      const [seqRow] = await db
        .select({ maxSeq: max(chatSessionEvents.seq) })
        .from(chatSessionEvents)
        .where(eq(chatSessionEvents.sessionId, event.sessionId));
      const record = { ...event, seq: (seqRow?.maxSeq ?? 0) + 1 };
      await db.insert(chatSessionEvents).values({
        id: record.id,
        sessionId: record.sessionId,
        seq: record.seq,
        kind: record.kind,
        payload: record.payload as Record<string, unknown>,
        timestamp: record.timestamp,
      });
      return record;
    });
  }

  async listBySession(sessionId: string): Promise<ChatSessionEventRecord[]> {
    const rows = await this.db
      .select()
      .from(chatSessionEvents)
      .where(eq(chatSessionEvents.sessionId, sessionId))
      .orderBy(asc(chatSessionEvents.seq));
    return rows.map(rowToEvent);
  }

  async nextSeq(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ maxSeq: max(chatSessionEvents.seq) })
      .from(chatSessionEvents)
      .where(eq(chatSessionEvents.sessionId, sessionId));
    return (row?.maxSeq ?? 0) + 1;
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.db.delete(chatSessionEvents).where(eq(chatSessionEvents.sessionId, sessionId));
  }

  async findLatestByKind(
    sessionId: string,
    kind: string,
  ): Promise<ChatSessionEventRecord | null> {
    const rows = await this.db
      .select()
      .from(chatSessionEvents)
      .where(and(eq(chatSessionEvents.sessionId, sessionId), eq(chatSessionEvents.kind, kind)))
      .orderBy(desc(chatSessionEvents.seq))
      .limit(1);
    const row = rows[0];
    return row ? rowToEvent(row) : null;
  }
}
