import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { feedEvents } from '../../db/schema.js';
function rowToFeedEvent(row) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        type: row.type,
        title: row.title,
        summary: row.summary ?? undefined,
        severity: row.severity ?? undefined,
        metadata: (row.metadata ?? undefined),
        createdAt: row.createdAt.toISOString(),
    };
}
export class PostgresFeedRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findById(id) {
        const [row] = await this.db.select().from(feedEvents).where(eq(feedEvents.id, id));
        return row ? rowToFeedEvent(row) : undefined;
    }
    async findAll(opts = {}) {
        const conditions = opts.tenantId ? [eq(feedEvents.tenantId, opts.tenantId)] : [];
        const rows = await this.db
            .select()
            .from(feedEvents)
            .where(conditions.length ? and(...conditions) : undefined)
            .limit(opts.limit ?? 100)
            .offset(opts.offset ?? 0);
        return rows.map(rowToFeedEvent);
    }
    async create(data) {
        return this.add(data);
    }
    async add(data) {
        const [row] = await this.db
            .insert(feedEvents)
            .values({
            id: randomUUID(),
            tenantId: data.tenantId,
            type: data.type,
            title: data.title,
            summary: data.summary,
            severity: data.severity,
            metadata: data.metadata,
            createdAt: new Date(),
        })
            .returning();
        return rowToFeedEvent(row);
    }
    async update(id, patch) {
        const [row] = await this.db
            .update(feedEvents)
            .set({
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
            ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
            ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        })
            .where(eq(feedEvents.id, id))
            .returning();
        return row ? rowToFeedEvent(row) : undefined;
    }
    async delete(id) {
        const result = await this.db.delete(feedEvents).where(eq(feedEvents.id, id));
        return (result.rowCount ?? 0) > 0;
    }
    async count() {
        const rows = await this.db.select().from(feedEvents);
        return rows.length;
    }
    async findByType(type, tenantId) {
        const conditions = [eq(feedEvents.type, type)];
        if (tenantId)
            conditions.push(eq(feedEvents.tenantId, tenantId));
        const rows = await this.db.select().from(feedEvents).where(and(...conditions));
        return rows.map(rowToFeedEvent);
    }
    async findBySeverity(severity, tenantId) {
        const conditions = [eq(feedEvents.severity, severity)];
        if (tenantId)
            conditions.push(eq(feedEvents.tenantId, tenantId));
        const rows = await this.db.select().from(feedEvents).where(and(...conditions));
        return rows.map(rowToFeedEvent);
    }
}
//# sourceMappingURL=feed.js.map