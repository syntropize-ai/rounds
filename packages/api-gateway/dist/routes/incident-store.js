import { randomUUID } from 'crypto';
export class IncidentStore {
    incidents = new Map();
    archivedItems = new Map();
    maxCapacity;
    tenants = new Map();
    constructor(maxCapacity = 500) {
        this.maxCapacity = maxCapacity;
    }
    create(params) {
        const now = new Date().toISOString();
        const id = `inc_${randomUUID().slice(0, 8)}`;
        const incident = {
            id,
            title: params.title,
            severity: params.severity,
            status: 'open',
            serviceIds: params.services ?? [],
            investigationIds: [],
            timeline: [],
            assignee: params.assignee,
            createdAt: now,
            updatedAt: now,
        };
        this.incidents.set(id, incident);
        if (params.tenantId)
            this.tenants.set(id, params.tenantId);
        this.evictIfNeeded();
        return incident;
    }
    evictIfNeeded() {
        if (this.incidents.size <= this.maxCapacity)
            return;
        let oldest;
        for (const inc of this.incidents.values()) {
            if (inc.status === 'resolved') {
                if (!oldest || inc.createdAt < oldest.createdAt)
                    oldest = inc;
            }
        }
        if (oldest) {
            this.archivedItems.set(oldest.id, oldest);
            this.incidents.delete(oldest.id);
        }
    }
    findById(id) {
        return this.incidents.get(id) ?? this.archivedItems.get(id);
    }
    getArchived() {
        return [...this.archivedItems.values()];
    }
    restoreFromArchive(id) {
        const inc = this.archivedItems.get(id);
        if (!inc)
            return undefined;
        this.archivedItems.delete(id);
        this.incidents.set(id, inc);
        return inc;
    }
    findAll(tenantId) {
        const all = [...this.incidents.values()];
        if (tenantId === undefined)
            return all;
        return all.filter((inc) => this.tenants.get(inc.id) === tenantId);
    }
    update(id, params) {
        const incident = this.incidents.get(id);
        if (!incident)
            return undefined;
        const now = new Date().toISOString();
        const oldStatus = incident.status;
        const updated = {
            ...incident,
            title: params.title ?? incident.title,
            status: params.status ?? incident.status,
            severity: params.severity ?? incident.severity,
            serviceIds: params.services ?? incident.serviceIds,
            assignee: params.assignee !== undefined ? params.assignee : incident.assignee,
            updatedAt: now,
            resolvedAt: params.status === 'resolved' && !incident.resolvedAt ? now : incident.resolvedAt,
        };
        // Auto-add timeline entry for status changes
        if (params.status && params.status !== oldStatus) {
            updated.timeline = [
                ...updated.timeline,
                this.createTimelineEntry('status_changed', `Status changed from ${oldStatus} to ${params.status}`, 'system', 'incident-store'),
            ];
        }
        this.incidents.set(id, updated);
        return updated;
    }
    addInvestigation(incidentId, investigationId) {
        const incident = this.incidents.get(incidentId);
        if (!incident)
            return undefined;
        if (incident.investigationIds.includes(investigationId))
            return incident;
        const now = new Date().toISOString();
        const updated = {
            ...incident,
            investigationIds: [...incident.investigationIds, investigationId],
            timeline: [
                ...incident.timeline,
                this.createTimelineEntry('investigation_created', `Investigation ${investigationId} linked to incident`, 'system', 'incident-store', investigationId),
            ],
            updatedAt: now,
        };
        this.incidents.set(incidentId, updated);
        return updated;
    }
    addTimelineEntry(incidentId, type, description, actorType, actorId, referenceId, data) {
        const incident = this.incidents.get(incidentId);
        if (!incident)
            return undefined;
        const entry = this.createTimelineEntry(type, description, actorType, actorId, referenceId, data);
        const now = new Date().toISOString();
        this.incidents.set(incidentId, {
            ...incident,
            timeline: [...incident.timeline, entry],
            updatedAt: now,
        });
        return entry;
    }
    getTimeline(incidentId) {
        const incident = this.incidents.get(incidentId);
        if (!incident)
            return undefined;
        return incident.timeline;
    }
    get size() {
        return this.incidents.size;
    }
    clear() {
        this.incidents.clear();
        this.archivedItems.clear();
        this.tenants.clear();
    }
    createTimelineEntry(type, description, actorType, actorId, referenceId, data) {
        return {
            id: `tle_${randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            type,
            description,
            actorType,
            actorId,
            referenceId,
            data,
        };
    }
}
export const incidentStore = new IncidentStore();
//# sourceMappingURL=incident-store.js.map