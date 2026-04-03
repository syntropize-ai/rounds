// @agentic-obs/data-layer - Object model and data access

export type { Service, Change, Symptom, Evidence, Investigation, Action } from '@agentic-obs/common';

export * from './session/index.js';
export * from './topology/index.js';
export * from './semantic-metrics/index.js';
export * from './db/index.js';
export * from './repository/index.js';
export * from './cache/index.js';

// Stores - re-exported selectively to avoid name conflicts with repository types.
// For the full store API, import from '@agentic-obs/data-layer/stores'.
export {
  // Persistence
  type Persistable,
  setMarkDirty,
  markDirty as markStoreDirty,

  // Alert Rule Store
  AlertRuleStore,
  defaultAlertRuleStore,

  // Approval Store
  ApprovalStore,
  approvalStore,
  type ApprovalRequest,
  type SubmitApprovalParams,

  // Incident Store
  IncidentStore,
  incidentStore,
  type CreateIncidentParams,
  type UpdateIncidentParams,
  type CreateIncidentParamsWithTenant,

  // Notification Store
  NotificationStore,
  defaultNotificationStore,

  // Post Mortem Store
  PostMortemStore,
  postMortemStore,

  // Feed Store
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

  // Investigation Store
  InvestigationStore,
  defaultInvestigationStore,
  type FollowUpRecord,
  type FeedbackBody,
  type StoredFeedback,

  // Share Store (ShareLink and SharePermission types intentionally not re-exported
  // here due to conflicts with repository/types.ts; import from the store interfaces instead)
  ShareStore,
  defaultShareStore,

  // Dashboard Store
  DashboardStore,
  defaultDashboardStore,

  // Conversation Store
  ConversationStore,
  defaultConversationStore,

  // Investigation Report Store
  InvestigationReportStore,
  defaultInvestigationReportStore,

  // Alert Rule Provider Adapter
  AlertRuleStoreProvider,

  // Workspace Store
  WorkspaceStore,
  defaultWorkspaceStore,

  // Version Store
  VersionStore,
  defaultVersionStore,

  // Gateway Interfaces
  type MaybeAsync,
  type IGatewayInvestigationStore,
  type IGatewayIncidentStore,
  type IGatewayFeedStore,
  type IGatewayApprovalStore,
  type IGatewayShareStore,
  type IGatewayDashboardStore,
  type IConversationStore,
  type GatewayStores,
} from './stores/index.js';
