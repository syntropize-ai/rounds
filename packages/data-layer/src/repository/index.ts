export type {
  MaybeAsync,
  IRepository,
  FindAllOptions,
  IInvestigationRepository,
  InvestigationFindAllOptions,
  IIncidentRepository,
  IncidentFindAllOptions,
  IFeedRepository,
  FeedFindAllOptions,
  IFeedItemRepository,
  ICaseRepository,
  CaseFindAllOptions,
  IApprovalRepository,
  IApprovalRequestRepository,
  ApprovalScopeFilter,
  IShareRepository,
  IShareLinkRepository,
  IDashboardRepository,
  IFolderRepository,
  IAlertRuleRepository,
  AlertRuleFindAllOptions,
  INotificationRepository,
  IVersionRepository,
  // IWorkspaceRepository removed in T9 cutover — use IOrgRepository.
  IInvestigationReportRepository,
  IPostMortemRepository,
  IChatSessionRepository,
  IChatSessionContextRepository,
  IChatMessageRepository,
  IChatSessionEventRepository,
  ChatSessionContextResourceScope,
  ChatSessionScope,
  ChatSessionEventRecord,
} from './interfaces.js';

export type {
  FeedEvent,
  Case,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalAction,
  ApprovalContext,
  SubmitApprovalParams,
  ShareLink,
  SharePermission,
} from './types.js';

export { InMemoryApprovalRequestRepository } from './memory/approval.js';

export type {
  IConnectorRepository,
} from './types/connector.js';

export type {
  INotificationDispatchRepository,
  NotificationDispatchRow,
  UpsertDispatchInput,
} from './types/notification-dispatch.js';

export type {
  IRemediationPlanRepository,
  ListRemediationPlansOptions,
  NewRemediationPlan,
  NewRemediationPlanStep,
  RemediationPlan,
  RemediationPlanPatch,
  RemediationPlanStatus,
  RemediationPlanStep,
  RemediationPlanStepKind,
  RemediationPlanStepPatch,
  RemediationPlanStepStatus,
} from './types/remediation-plan.js';

export * from './postgres/index.js';
export * from './sqlite/index.js';
export * from './event-wrappers/index.js';
export * from './memory/index.js';
export { createPostgresRepositories, createSqliteRepositories } from './factory.js';
export type { RepositoryBundle, SqliteRepositories } from './factory.js';

export { SqliteLlmAuditRepository } from './sqlite/llm-audit-repository.js';
export { PostgresLlmAuditRepository } from './postgres/llm-audit-repository.js';
export type {
  ILlmAuditRepository,
  LlmAuditRecord,
  LlmAuditErrorKind,
  NewLlmAuditRecord,
} from './sqlite/llm-audit-repository.js';
