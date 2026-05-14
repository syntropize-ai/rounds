// @agentic-obs/data-layer - Object model and data access
//
// Naming convention:
//   I*Repository  — abstract persistence interfaces (repository/)
//   *Store        — in-memory implementations (stores/)
//   IGateway*     — gateway-facing subset interfaces (stores/)

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

// ── Store implementations ────────────────────────────────────────────────
// Re-exported selectively to avoid name conflicts with repository types.
// For the full store API, import from '@agentic-obs/data-layer/stores'.
export {
  // Persistence helpers
  type Persistable,
  setMarkDirty,
  markDirty as markStoreDirty,

  // Alert Rule
  AlertRuleStore,
  defaultAlertRuleStore,

  // Approval — store removed in M3 (ADR-001); types now live in
  // ./repository/types.ts and are re-exported via ./repository/index.ts.

  // Incident
  IncidentStore,
  incidentStore,
  type CreateIncidentParams,
  type UpdateIncidentParams,
  type CreateIncidentParamsWithTenant,

  // Notification
  NotificationStore,
  defaultNotificationStore,

  // Post Mortem
  PostMortemStore,
  postMortemStore,

  // Feed
  FeedStore,
  feedStore,
  type FeedEventType,
  type FeedSeverity,
  type FeedStatus,
  type FeedFeedback,
  type HypothesisFeedback,
  type ActionFeedback,
  type FeedItem,
  type FeedPage,
  type FeedListOptions,
  type FeedbackStats,

  // Investigation
  InvestigationStore,
  defaultInvestigationStore,
  type FollowUpRecord,
  type FeedbackBody,
  type StoredFeedback,

  // Share
  ShareStore,
  defaultShareStore,
  type ShareLookupResult,

  // Dashboard
  DashboardStore,
  defaultDashboardStore,

  // Investigation Report
  InvestigationReportStore,
  defaultInvestigationReportStore,

  // Alert Rule Provider Adapter
  AlertRuleStoreProvider,

  // Folder
  FolderStore,
  defaultFolderStore,
  type Folder,

  // Workspace: removed in T9 cutover; use OrgRepository.

  // Version
  VersionStore,
  defaultVersionStore,

  // Gateway interfaces (subset of store APIs consumed by the API gateway)
  type MaybeAsync,
  type IGatewayInvestigationStore,
  type IGatewayIncidentStore,
  type IGatewayFeedStore,
  type IGatewayApprovalStore,
  type IGatewayShareStore,
  type IGatewayDashboardStore,
  type GatewayStores,
} from './stores/index.js';
