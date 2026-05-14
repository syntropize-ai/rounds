// Store factory - creates all gateway stores based on runtime config.
//
// Backward-compatible: when DATABASE_URL is not configured, returns in-memory
// instances. Approval moved off the legacy ApprovalStore onto
// InMemoryApprovalRequestRepository in M3 (ADR-001).

import {
  InvestigationStore,
  defaultInvestigationStore,
  IncidentStore,
  incidentStore,
  FeedStore,
  feedStore,
  InMemoryApprovalRequestRepository,
  ShareStore,
  defaultShareStore,
  DashboardStore,
  defaultDashboardStore,
} from '@agentic-obs/data-layer'
import type { GatewayStores } from './types.js'

/**
 * Singleton in-memory approval repository for the default mode. Mirrors the
 * old `approvalStore` singleton so the proactive pipeline and route handlers
 * still share the same instance.
 */
const defaultApprovalRepo = new InMemoryApprovalRequestRepository();

/** Create a set of in-memory stores (default mode, no external dependencies). */
export function createInMemoryStores(): GatewayStores {
  return {
    investigations: new InvestigationStore(),
    incidents: new IncidentStore(),
    feed: new FeedStore(),
    approvals: new InMemoryApprovalRequestRepository(),
    shares: new ShareStore(),
    dashboards: new DashboardStore(),
  }
}

/**
 * Return the module-level singleton stores.
 * Used by server.ts so that the proactive pipeline and route handlers share
 * the same store instances (same as before this migration).
 */
export function createDefaultStores(): GatewayStores {
  return {
    investigations: defaultInvestigationStore,
    incidents: incidentStore,
    feed: feedStore,
    approvals: defaultApprovalRepo,
    shares: defaultShareStore,
    dashboards: defaultDashboardStore,
  }
}
