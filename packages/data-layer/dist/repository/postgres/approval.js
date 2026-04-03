import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { approvals } from '../../db/schema.js';
function rowToRecord(row) {
    const params = (row.params ?? {});
    return {
        id: row.id,
        tenantId: row.tenantId,
        actionType: row.actionType,
        action: {
            type: String(params['type'] ?? row.actionType),
            targetService: String(params['targetService'] ?? ''),
            params,
        },
        context: {
            investigationId: typeof params['investigationId'] === 'string' ? params['investigationId'] : undefined,
            requestedBy: row.requestedBy,
            reason: typeof params['reason'] === 'string' ? params['reason'] : '',
        },
        requestedBy: row.requestedBy,
        resolvedBy: row.resolvedBy ?? undefined,
        status: row.status,
        params,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString(),
    };
}
export class PostgresApprovalRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findById(id) {
        const [row] = await this.db.select().from(approvals).where(eq(approvals.id, id));
        return row ? rowToRecord(row) : undefined;
    }
    async findAll(opts) {
        const rows = await this.db
            .select()
            .from(approvals)
            .limit(opts?.limit ?? 100)
            .offset(opts?.offset ?? 0);
        return rows.map(rowToRecord);
    }
    async create(data) {
        return this.submit(data);
    }
    async submit(data) {
        const [row] = await this.db
            .insert(approvals)
            .values({
            id: randomUUID(),
            tenantId: data.tenantId,
            actionType: data.actionType,
            requestedBy: data.requestedBy,
            status: data.status,
            params: data.params,
            createdAt: new Date(),
        })
            .returning();
        return rowToRecord(row);
    }
    async update(id, patch) {
        const [row] = await this.db
            .update(approvals)
            .set({
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.resolvedBy !== undefined ? { resolvedBy: patch.resolvedBy } : {}),
            ...(patch.resolvedAt !== undefined ? { resolvedAt: new Date(patch.resolvedAt) } : {}),
        })
            .where(eq(approvals.id, id))
            .returning();
        return row ? rowToRecord(row) : undefined;
    }
    async delete(id) {
        const result = await this.db.delete(approvals).where(eq(approvals.id, id));
        return (result.rowCount ?? 0) > 0;
    }
    async count() {
        const rows = await this.db.select().from(approvals);
        return rows.length;
    }
    async listPending(tenantId) {
        const conditions = [eq(approvals.status, 'pending')];
        if (tenantId)
            conditions.push(eq(approvals.tenantId, tenantId));
        const rows = await this.db.select().from(approvals).where(and(...conditions));
        return rows.map(rowToRecord).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    async approve(id, by, roles) {
        const existing = await this.findById(id);
        if (!existing || existing.status !== 'pending')
            return undefined;
        return this.update(id, { status: 'approved', resolvedBy: by, resolvedAt: new Date().toISOString() });
    }
    async reject(id, by, roles) {
        const existing = await this.findById(id);
        if (!existing || existing.status !== 'pending')
            return undefined;
        return this.update(id, { status: 'rejected', resolvedBy: by, resolvedAt: new Date().toISOString() });
    }
    async override(id, by, roles) {
        return this.update(id, { status: 'approved', resolvedBy: by, resolvedAt: new Date().toISOString() });
    }
}
//# sourceMappingURL=approval.js.map