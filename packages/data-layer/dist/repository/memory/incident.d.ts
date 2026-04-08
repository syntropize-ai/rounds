import type { Incident, IncidentTimelineEntry, IncidentTimelineEntryType } from '@agentic-obs/common';
import type { IIncidentRepository, IncidentFindAllOptions } from '../interfaces.js';
export declare class InMemoryIncidentRepository implements IIncidentRepository {
    private readonly active;
    private readonly archived;
    private readonly workspaceMap;
    findById(id: string): Promise<Incident | undefined>;
    findAll(opts?: IncidentFindAllOptions): Promise<Incident[]>;
    create(data: Omit<Incident, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<Incident>;
    update(id: string, patch: Partial<Omit<Incident, 'id'>>): Promise<Incident | undefined>;
    delete(id: string): Promise<boolean>;
    count(): Promise<number>;
    addTimelineEntry(incidentId: string, entry: Omit<IncidentTimelineEntry, 'id' | 'timestamp'> & {
        type?: IncidentTimelineEntryType;
    }): Promise<IncidentTimelineEntry | undefined>;
    findByService(serviceId: string, _tenantId?: string): Promise<Incident[]>;
    findByWorkspace(workspaceId: string): Promise<Incident[]>;
    addInvestigation(incidentId: string, investigationId: string): Promise<Incident | undefined>;
    getTimeline(incidentId: string): Promise<IncidentTimelineEntry[] | undefined>;
    archive(id: string): Promise<Incident | undefined>;
    restore(id: string): Promise<Incident | undefined>;
    findArchived(_tenantId?: string): Promise<Incident[]>;
    /** Test helper */
    clear(): void;
}
//# sourceMappingURL=incident.d.ts.map