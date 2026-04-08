import { eq, isNull, isNotNull, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { incidents, incidentTimeline } from '../../db/schema.js';
function rowToTimelineEntry(row) {
    return {
        id: row.id,
        timestamp: row.timestamp.toISOString(),
        type: row.type,
        description: row.description,
        actorType: (row.actorType ?? 'system'),
        actorId: row.actorId ?? '',
        referenceId: row.referenceId ?? undefined,
        data: (row.metadata ?? undefined),
    };
}
function rowToIncident(row, timeline = []) {
    return {
        id: row.id,
        title: row.title,
        severity: row.severity,
        status: row.status,
        serviceIds: row.services ?? [],
        investigationIds: [],
        timeline: timeline.map(rowToTimelineEntry),
        assignee: row.assignee ?? undefined,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        resolvedAt: undefined,
    };
}
export class PostgresIncidentRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findById(id) {
        const [row] = await this.db.select().from(incidents).where(eq(incidents.id, id));
        if (!row)
            return undefined;
        const timeline = await this.db
            .select()
            .from(incidentTimeline)
            .where(eq(incidentTimeline.incidentId, id));
        return rowToIncident(row, timeline);
    }
    async findAll(opts = {}) {
        const conditions = [isNull(incidents.archivedAt)];
        if (opts.tenantId)
            conditions.push(eq(incidents.tenantId, opts.tenantId));
        if (opts.status)
            conditions.push(eq(incidents.status, opts.status));
        const rows = await this.db
            .select()
            .from(incidents)
            .where(and(...conditions))
            .limit(opts.limit ?? 100)
            .offset(opts.offset ?? 0);
        return rows.map((r) => rowToIncident(r));
    }
    async create(data) {
        const now = new Date();
        const id = data.id ?? `inc_${randomUUID().slice(0, 8)}`;
        const tenantId = data.tenantId ?? 'default';
        const [row] = await this.db
            .insert(incidents)
            .values({
            id,
            tenantId,
            title: data.title,
            severity: data.severity,
            status: data.status,
            services: data.serviceIds,
            assignee: data.assignee,
            createdAt: now,
            updatedAt: now,
        })
            .returning();
        return rowToIncident(row);
    }
    async update(id, patch) {
        const [row] = await this.db
            .update(incidents)
            .set({
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
            ...(patch.serviceIds !== undefined ? { services: patch.serviceIds } : {}),
            ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
            updatedAt: new Date(),
        })
            .where(eq(incidents.id, id))
            .returning();
        return row ? rowToIncident(row) : undefined;
    }
    async delete(id) {
        const result = await this.db.delete(incidents).where(eq(incidents.id, id));
        return (result.rowCount ?? 0) > 0;
    }
    async count() {
        const rows = await this.db.select().from(incidents).where(isNull(incidents.archivedAt));
        return rows.length;
    }
    async addTimelineEntry(incidentId, entry) {
        const existing = await this.db.select().from(incidents).where(eq(incidents.id, incidentId));
        if (!existing.length)
            return undefined;
        const [row] = await this.db
            .insert(incidentTimeline)
            .values({
            id: `tle_${randomUUID().slice(0, 8)}`,
            incidentId,
            type: entry.type,
            description: entry.description,
            actorType: entry.actorType,
            actorId: entry.actorId,
            referenceId: entry.referenceId,
            metadata: entry.data,
            timestamp: new Date(),
        })
            .returning();
        return row ? rowToTimelineEntry(row) : undefined;
    }
    async findByService(serviceId, tenantId) {
        const rows = await this.db.select().from(incidents).where(isNull(incidents.archivedAt));
        return rows
            .filter((r) => {
            const svcs = r.services;
            return svcs.includes(serviceId) && (tenantId === undefined || r.tenantId === tenantId);
        })
            .map((r) => rowToIncident(r));
    }
    async archive(id) {
        const [row] = await this.db
            .update(incidents)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(eq(incidents.id, id))
            .returning();
        return row ? rowToIncident(row) : undefined;
    }
    async restore(id) {
        const [row] = await this.db
            .update(incidents)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(eq(incidents.id, id))
            .returning();
        return row ? rowToIncident(row) : undefined;
    }
    async findArchived(tenantId) {
        const conditions = [isNotNull(incidents.archivedAt)];
        if (tenantId)
            conditions.push(eq(incidents.tenantId, tenantId));
        const rows = await this.db
            .select()
            .from(incidents)
            .where(and(...conditions));
        return rows.map((r) => rowToIncident(r));
    }
    async findByWorkspace(_workspaceId) {
        return [];
    }
    async addInvestigation(incidentId, investigationId) {
        const incident = await this.findById(incidentId);
        if (!incident)
            return undefined;
        if (incident.investigationIds.includes(investigationId))
            return incident;
        // Store investigationIds in timeline entry since PG schema doesn't have the column
        await this.addTimelineEntry(incidentId, {
            type: 'investigation_created',
            description: `Investigation ${investigationId} linked to incident`,
            actorType: 'system',
            actorId: 'incident-repo',
            referenceId: investigationId,
        });
        return this.findById(incidentId);
    }
    async getTimeline(incidentId) {
        const incident = await this.findById(incidentId);
        return incident?.timeline;
    }
}
//# sourceMappingURL=incident.js.map