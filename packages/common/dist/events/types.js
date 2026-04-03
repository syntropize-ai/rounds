// Event envelope and standard event type definitions
import { randomUUID } from 'crypto';
export function createEvent(type, payload, tenantId) {
    return {
        id: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        tenantId,
        payload,
    };
}
// Standard event type constants
export const EventTypes = {
    // Investigation lifecycle
    INVESTIGATION_CREATED: 'investigation.created',
    INVESTIGATION_UPDATED: 'investigation.updated',
    INVESTIGATION_COMPLETED: 'investigation.completed',
    INVESTIGATION_FAILED: 'investigation.failed',
    // Incident lifecycle
    INCIDENT_CREATED: 'incident.created',
    INCIDENT_UPDATED: 'incident.updated',
    INCIDENT_RESOLVED: 'incident.resolved',
    // Action lifecycle
    ACTION_REQUESTED: 'action.requested',
    ACTION_APPROVED: 'action.approved',
    ACTION_REJECTED: 'action.rejected',
    ACTION_EXECUTED: 'action.executed',
    ACTION_FAILED: 'action.failed',
    // Finding / feed
    FINDING_CREATED: 'finding.created',
    FINDING_UPDATED: 'finding.updated',
    // Feed events
    FEED_ITEM_CREATED: 'feed.item.created',
    FEED_ITEM_READ: 'feed.item.read',
};
//# sourceMappingURL=types.js.map