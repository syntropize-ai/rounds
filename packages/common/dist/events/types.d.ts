export interface EventEnvelope<T = unknown> {
    id: string;
    type: string;
    timestamp: string;
    tenantId?: string;
    payload: T;
}
export declare function createEvent<T>(type: string, payload: T, tenantId?: string): EventEnvelope<T>;
export declare const EventTypes: {
    readonly INVESTIGATION_CREATED: "investigation.created";
    readonly INVESTIGATION_UPDATED: "investigation.updated";
    readonly INVESTIGATION_COMPLETED: "investigation.completed";
    readonly INVESTIGATION_FAILED: "investigation.failed";
    readonly INCIDENT_CREATED: "incident.created";
    readonly INCIDENT_UPDATED: "incident.updated";
    readonly INCIDENT_RESOLVED: "incident.resolved";
    readonly ACTION_REQUESTED: "action.requested";
    readonly ACTION_APPROVED: "action.approved";
    readonly ACTION_REJECTED: "action.rejected";
    readonly ACTION_EXECUTED: "action.executed";
    readonly ACTION_FAILED: "action.failed";
    readonly FINDING_CREATED: "finding.created";
    readonly FINDING_UPDATED: "finding.updated";
    readonly FEED_ITEM_CREATED: "feed.item.created";
    readonly FEED_ITEM_READ: "feed.item.read";
};
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
export interface InvestigationEventPayload {
    investigationId: string;
    status?: string;
    userId?: string;
    sessionId?: string;
}
export interface IncidentEventPayload {
    incidentId: string;
    title: string;
    severity?: string;
}
export interface ActionEventPayload {
    actionId: string;
    actionType: string;
    investigationId?: string;
    approvedBy?: string;
}
export interface FindingEventPayload {
    findingId: string;
    title: string;
    severity?: string;
    investigationId?: string;
}
export interface FeedItemEventPayload {
    itemId: string;
    type: string;
    investigationId?: string;
}
//# sourceMappingURL=types.d.ts.map