// Store factory - creates all gateway stores based on runtime config.
//
// Backward-compatible: when DATABASE_URL is not configured, returns the
// existing in-memory store instances. This means all current behaviour and
// tests continue to work without changes.
//
// Future extension: when DATABASE_URL is set, return repository-backed
// adapters that delegate to the Postgres implementations in @agentic-obs/data-layer.
import { InvestigationStore, defaultInvestigationStore } from '../routes/investigation/store.js';
import { IncidentStore, incidentStore } from '../routes/incident-store.js';
import { FeedStore, feedStore } from '../routes/feed-store.js';
import { ApprovalStore, approvalStore } from '../routes/approval-store.js';
import { ShareStore, defaultShareStore } from '../routes/investigation/share-store.js';
import { DashboardStore, defaultDashboardStore } from '../routes/dashboard/store.js';
import { ConversationStore, defaultConversationStore } from '../routes/dashboard/conversation-store.js';
/** Create a set of in-memory stores (default mode, no external dependencies). */
export function createInMemoryStores() {
  return {
    investigations: new InvestigationStore(),
    incidents: new IncidentStore(),
    feed: new FeedStore(),
    approvals: new ApprovalStore(),
    shares: new ShareStore(),
    dashboards: new DashboardStore(),
    conversations: new ConversationStore(),
  };
}
/**
 * Return the module-level singleton stores.
 * Used by server.ts so that the proactive pipeline and route handlers share
 * the same store instances (same as before this migration).
 */
export function createDefaultStores() {
  return {
    investigations: defaultInvestigationStore,
    incidents: incidentStore,
    feed: feedStore,
    approvals: approvalStore,
    shares: defaultShareStore,
    dashboards: defaultDashboardStore,
    conversations: defaultConversationStore,
  };
}
//# sourceMappingURL=factory.js.map
