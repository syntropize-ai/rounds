import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { DbClient } from '../../db/client.js';
import { feedEvents } from '../../db/schema.js';
import type { IFeedRepository, FeedFindAllOptions } from '../interfaces.js';
import type { FeedEvent } from '../types.js';

type FeedRow = typeof feedEvents.$inferSelect;

function rowToFeedEvent(row: FeedRow): FeedEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    title: row.title,
    summary: row.summary ?? undefined,
    severity: row.severity ?? undefined,
    metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresFeedRepository implements IFeedRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<FeedEvent | undefined> {
    const [row] = await this.db.select().from(feedEvents).where(eq(feedEvents.id, id));
    return row ? rowToFeedEvent(row) : undefined;
  }

  async findAll(opts: FeedFindAllOptions = {}): Promise<FeedEvent[]> {
    const conditions = opts.tenantId ? [eq(feedEvents.tenantId, opts.tenantId)] : [];
    const rows = await this.db
      .select()
      .from(feedEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map(rowToFeedEvent);
  }

  async create(data: Omit<FeedEvent, 'id' | 'createdAt'> & { id?: string }): Promise<FeedEvent> {
    return this.add(data);
  }

  async add(data: Omit<FeedEvent, 'id' | 'createdAt'>): Promise<FeedEvent> {
    const [row] = await this.db
      .insert(feedEvents)
      .values({
        id: randomUUID(),
        tenantId: data.tenantId,
        type: data.type,
        title: data.title,
        summary: data.summary,
        severity: data.severity,
        metadata: data.metadata as Record<string, unknown> | undefined,
        createdAt: new Date(),
      })
      .returning();
    return rowToFeedEvent(row!);
  }

  async update(id: string, patch: Partial<Omit<FeedEvent, 'id'>>): Promise<FeedEvent | undefined> {
    const [row] = await this.db
      .update(feedEvents)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata as Record<string, unknown> } : {}),
      })
      .where(eq(feedEvents.id, id))
      .returning();
    return row ? rowToFeedEvent(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(feedEvents).where(eq(feedEvents.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.db.select().from(feedEvents);
    return rows.length;
  }

  async findByType(type: string, tenantId?: string): Promise<FeedEvent[]> {
    const conditions = [eq(feedEvents.type, type)];
    if (tenantId) conditions.push(eq(feedEvents.tenantId, tenantId));
    const rows = await this.db.select().from(feedEvents).where(and(...conditions));
    return rows.map(rowToFeedEvent);
  }

  async findBySeverity(severity: string, tenantId?: string): Promise<FeedEvent[]> {
    const conditions = [eq(feedEvents.severity, severity)];
    if (tenantId) conditions.push(eq(feedEvents.tenantId, tenantId));
    const rows = await this.db.select().from(feedEvents).where(and(...conditions));
    return rows.map(rowToFeedEvent);
  }
}
