import { and, asc, desc, eq, max } from 'drizzle-orm';
import { chatSessionEvents } from '../../db/schema.js';
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

export class PostgresChatSessionEventRepository implements IChatSessionEventRepository {
  constructor(private readonly db: any) {}

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
