import type { Incident, IncidentTimelineEntry, IncidentTimelineEntryType } from '@agentic-obs/common';
import type { IIncidentRepository, IncidentFindAllOptions } from '../interfaces.js';
export declare class InMemoryIncidentRepository implements IIncidentRepository {
    private readonly active;
    private readonly archived;
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
    archive(id: string): Promise<Incident | undefined>;
    restore(id: string): Promise<Incident | undefined>;
    /** Test helper */
    clear(): void;
}
//# sourceMappingURL=incident.d.ts.map