import type { Incident, IncidentStatus, IncidentSeverity, IncidentTimelineEntry, IncidentTimelineEntryType } from '@agentic-obs/common';
export interface CreateIncidentParams {
    title: string;
    severity: IncidentSeverity;
    services?: string[];
    assignee?: string;
}
export interface UpdateIncidentParams {
    title?: string;
    status?: IncidentStatus;
    severity?: IncidentSeverity;
    services?: string[];
    assignee?: string;
}
export interface CreateIncidentParamsWithTenant extends CreateIncidentParams {
    tenantId?: string;
}
export declare class IncidentStore {
    private readonly incidents;
    private readonly archivedItems;
    private readonly maxCapacity;
    private readonly tenants;
    constructor(maxCapacity?: number);
    create(params: CreateIncidentParamsWithTenant): Incident;
    private evictIfNeeded;
    findById(id: string): Incident | undefined;
    getArchived(): Incident[];
    restoreFromArchive(id: string): Incident | undefined;
    findAll(tenantId?: string): Incident[];
    update(id: string, params: UpdateIncidentParams): Incident | undefined;
    addInvestigation(incidentId: string, investigationId: string): Incident | undefined;
    addTimelineEntry(incidentId: string, type: IncidentTimelineEntryType, description: string, actorType: 'system' | 'human', actorId: string, referenceId?: string, data?: Record<string, unknown>): IncidentTimelineEntry | undefined;
    getTimeline(incidentId: string): IncidentTimelineEntry[] | undefined;
    get size(): number;
    clear(): void;
    private createTimelineEntry;
}
export declare const incidentStore: IncidentStore;
//# sourceMappingURL=incident-store.d.ts.map