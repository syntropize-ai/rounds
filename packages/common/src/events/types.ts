// Event envelope and standard event type definitions
//
// NOTE: no Node imports here. The helper `createEvent` (which wraps
// `randomUUID`) lives in ./create-event.ts so this file stays
// browser-safe and can be re-exported from the frontend-facing barrel.

// Event envelope

export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  timestamp: string;
  tenantId?: string;
  payload: T;
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
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

// Payload types for well-known events

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
