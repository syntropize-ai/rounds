// @agentic-obs/data-layer - Object model and data access
//
// Naming convention:
//   I*Repository  — abstract persistence interfaces (repository/)
//   IGateway*     — gateway-facing subset interfaces (repository/gateway-interfaces.ts)
//
// Note: in-memory `*Store` classes (incident, feed, investigation, share,
// folder, version, post-mortem, investigation-report) were retired in
// Sprint 4. The only remaining `stores/` exports are `NotificationStore`
// (still in use by routes) and the `Persistable` persistence shim.

// ── Domain models (re-exported from common) ──────────────────────────────
export type { Service, Change, Symptom, Evidence, Investigation, Action } from '@agentic-obs/common';

// ── Subsystems ───────────────────────────────────────────────────────────
export * from './session/index.js';
export * from './topology/index.js';
export * from './db/index.js';
export * from './cache/index.js';

// ── Repository interfaces ────────────────────────────────────────────────
export * from './repository/index.js';

// ── Auth / permissions repositories (Grafana-parity, Wave 1) ────────────
export * from './repository/auth/index.js';

// ── RBAC seed (Grafana-parity, Wave 2 / T3.1) ───────────────────────────
// Populates `role`, `permission`, `builtin_role` with the action catalog's
// built-in + fixed roles. Consumed by the bootstrap flow and by admin
// `POST /api/access-control/seed`.
export { seedRbacForOrg, type SeedRbacResult } from './seed/rbac-seed.js';

// ── Test fixtures & in-memory DB helper (exported so other workspaces can
// ── use them in integration tests).
export * from './test-support/index.js';

// ── Remaining store implementations (persistence shim + NotificationStore) ─
export {
  type Persistable,
  setMarkDirty,
  markDirty as markStoreDirty,
  NotificationStore,
  defaultNotificationStore,
} from './stores/index.js';

// ── Repository type re-exports (canonical homes after store→repo migration) ─
export type {
  CreateIncidentParams,
  UpdateIncidentParams,
  CreateIncidentParamsWithTenant,
} from './repository/types/incident.js';
export type {
  FeedEventType,
  FeedSeverity,
  FeedStatus,
  FeedFeedback,
  HypothesisFeedback,
  ActionFeedback,
  FeedItem,
  FeedPage,
  FeedListOptions,
  FeedbackStats,
} from './repository/types/feed.js';
export type {
  FollowUpRecord,
  FeedbackBody,
  StoredFeedback,
} from './repository/types/investigation.js';
export type {
  ShareLookupResult,
  ShareLink,
  SharePermission,
} from './repository/types/share.js';
export type { Folder } from './repository/types/folder.js';

// ── Gateway-facing interfaces (DI shapes consumed by the API gateway) ────
export type {
  MaybeAsync,
  IGatewayInvestigationStore,
  IGatewayIncidentStore,
  IGatewayFeedStore,
  IGatewayApprovalStore,
  IGatewayShareStore,
  IGatewayDashboardStore,
  GatewayStores,
} from './repository/gateway-interfaces.js';
