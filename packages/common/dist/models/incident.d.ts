export type IncidentStatus = 'open' | 'mitigated' | 'resolved';
export type IncidentSeverity = 'P1' | 'P2' | 'P3' | 'P4';
export type IncidentTimelineEntryType = 'investigation_created' | 'status_changed' | 'conclusion_generated' | 'action_executed' | 'action_approved' | 'action_rejected' | 'verification_result' | 'note_added';
export interface IncidentTimelineEntry {
    id: string;
    timestamp: string;
    type: IncidentTimelineEntryType;
    description: string;
    actorType: 'system' | 'human';
    actorId: string;
    /** ID of related entity (investigation, action, etc.) */
    referenceId?: string;
    /** Arbitrary structured data for this timeline entry */
    data?: Record<string, unknown>;
}
export interface Incident {
    id: string;
    title: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    /** Service IDs affected by this incident */
    serviceIds: string[];
    /** IDs of investigations associated with this incident */
    investigationIds: string[];
    timeline: IncidentTimelineEntry[];
    assignee?: string;
    createdAt: string;
    updatedAt: string;
    resolvedAt?: string;
}
//# sourceMappingURL=incident.d.ts.map