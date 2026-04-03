import { eq, isNull, isNotNull, and, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { investigations } from '../../db/schema.js';
function rowToInvestigation(row) {
    return {
        id: row.id,
        sessionId: row.sessionId ?? '',
        userId: row.userId ?? '',
        intent: row.intent,
        structuredIntent: (row.structuredIntent ?? {}),
        plan: (row.plan ?? { entity: '', objective: '', steps: [], stopConditions: [] }),
        status: row.status,
        hypotheses: row.hypotheses ?? [],
        evidence: row.evidence ?? [],
        symptoms: row.symptoms ?? [],
        actions: [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
export class PostgresInvestigationRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findById(id) {
        const [row] = await this.db.select().from(investigations).where(eq(investigations.id, id));
        return row ? rowToInvestigation(row) : undefined;
    }
    async findAll(opts = {}) {
        const conditions = [isNull(investigations.archivedAt)];
        if (opts.tenantId)
            conditions.push(eq(investigations.tenantId, opts.tenantId));
        if (opts.status)
            conditions.push(eq(investigations.status, opts.status));
        const rows = await this.db
            .select()
            .from(investigations)
            .where(and(...conditions))
            .limit(opts.limit ?? 100)
            .offset(opts.offset ?? 0);
        return rows.map(rowToInvestigation);
    }
    async create(data) {
        const now = new Date();
        const id = data.id ?? `inv_${randomUUID().slice(0, 8)}`;
        const [row] = await this.db
            .insert(investigations)
            .values({
            id,
            tenantId: data.tenantId ?? 'default',
            sessionId: data.sessionId,
            userId: data.userId,
            intent: data.intent,
            structuredIntent: data.structuredIntent,
            plan: data.plan,
            status: data.status,
            hypotheses: data.hypotheses,
            evidence: data.evidence,
            symptoms: data.symptoms,
            createdAt: now,
            updatedAt: now,
        })
            .returning();
        return rowToInvestigation(row);
    }
    async update(id, patch) {
        const [row] = await this.db
            .update(investigations)
            .set({
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
            ...(patch.hypotheses !== undefined ? { hypotheses: patch.hypotheses } : {}),
            ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
            ...(patch.symptoms !== undefined ? { symptoms: patch.symptoms } : {}),
            updatedAt: new Date(),
        })
            .where(eq(investigations.id, id))
            .returning();
        return row ? rowToInvestigation(row) : undefined;
    }
    async delete(id) {
        const result = await this.db.delete(investigations).where(eq(investigations.id, id));
        return (result.rowCount ?? 0) > 0;
    }
    async count() {
        const result = await this.db
            .select({ count: sql `count(*)` })
            .from(investigations)
            .where(isNull(investigations.archivedAt));
        return Number(result[0]?.count ?? 0);
    }
    async findBySession(sessionId) {
        const rows = await this.db
            .select()
            .from(investigations)
            .where(eq(investigations.sessionId, sessionId));
        return rows.map(rowToInvestigation);
    }
    async findByUser(userId, tenantId) {
        const conditions = [eq(investigations.userId, userId), isNull(investigations.archivedAt)];
        if (tenantId)
            conditions.push(eq(investigations.tenantId, tenantId));
        const rows = await this.db
            .select()
            .from(investigations)
            .where(and(...conditions));
        return rows.map(rowToInvestigation);
    }
    async archive(id) {
        const [row] = await this.db
            .update(investigations)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(eq(investigations.id, id))
            .returning();
        return row ? rowToInvestigation(row) : undefined;
    }
    async restore(id) {
        const [row] = await this.db
            .update(investigations)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(eq(investigations.id, id))
            .returning();
        return row ? rowToInvestigation(row) : undefined;
    }
    async findArchived(tenantId) {
        const conditions = [isNotNull(investigations.archivedAt)];
        if (tenantId)
            conditions.push(eq(investigations.tenantId, tenantId));
        const rows = await this.db
            .select()
            .from(investigations)
            .where(and(...conditions));
        return rows.map(rowToInvestigation);
    }
}
//# sourceMappingURL=investigation.js.map