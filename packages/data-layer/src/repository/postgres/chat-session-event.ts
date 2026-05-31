import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
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

  async appendNext(
    event: Omit<ChatSessionEventRecord, 'seq'>,
  ): Promise<ChatSessionEventRecord> {
    return this.db.withTransaction(async (tx: any) => {
      await tx.run(sql`SELECT pg_advisory_xact_lock(hashtext(${event.sessionId}))`);
      const seqRows = await tx.all(sql`
        SELECT COALESCE(MAX(seq), 0)::int AS max_seq
        FROM chat_session_events
        WHERE session_id = ${event.sessionId}
      `) as Array<{ max_seq: number | null }>;
      const [seqRow] = seqRows;
      const record = { ...event, seq: Number(seqRow?.max_seq ?? 0) + 1 };
      await tx.run(sql`
        INSERT INTO chat_session_events (id, session_id, seq, kind, payload, timestamp)
        VALUES (
          ${record.id},
          ${record.sessionId},
          ${record.seq},
          ${record.kind},
          ${JSON.stringify(record.payload)}::jsonb,
          ${record.timestamp}
        )
      `);
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
