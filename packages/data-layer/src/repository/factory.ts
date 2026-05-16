import type { SqliteClient } from '../db/sqlite-client.js';
import type { DbClient } from '../db/client.js';
import type { QueryClient } from '../db/query-client.js';
import type {
  IIncidentRepository,
  IFeedItemRepository,
  IApprovalRequestRepository,
  IShareLinkRepository,
  IFolderRepository,
  IAlertRuleRepository,
  INotificationRepository,
  IVersionRepository,
  IInvestigationReportRepository,
  IPostMortemRepository,
  IChatSessionRepository,
  IChatSessionContextRepository,
  IChatMessageRepository,
  IChatSessionEventRepository,
} from './interfaces.js';
import type { IInvestigationRepository as SqliteInvestigationRepositoryInterface } from './sqlite/investigation.js';
import type {
  IDashboardRepository,
  IInstanceConfigRepository,
  INotificationChannelRepository,
} from '@agentic-obs/common';
import type { IConnectorRepository } from './types/connector.js';
import type {
  IGatewayInvestigationStore,
  IGatewayIncidentStore,
  IGatewayApprovalStore,
  IGatewayShareStore,
} from '../stores/interfaces.js';

import { InvestigationRepository } from './sqlite/investigation.js';
import { SqliteIncidentRepository } from './sqlite/incident.js';
import { SqliteFeedItemRepository } from './sqlite/feed.js';
import { SqliteApprovalRequestRepository } from './sqlite/approval.js';
import { SqliteShareLinkRepository } from './sqlite/share.js';
import { DashboardRepository as SqliteDashboardRepository } from './sqlite/dashboard.js';
import { SqliteFolderRepository } from './sqlite/folder.js';
import { SqliteAlertRuleRepository } from './sqlite/alert-rule.js';
import { SqliteNotificationRepository } from './sqlite/notification.js';
import { SqliteVersionRepository } from './sqlite/version.js';
import { SqliteInvestigationReportRepository } from './sqlite/investigation-report.js';
import { SqlitePostMortemRepository } from './sqlite/post-mortem.js';
import { SqliteChatSessionRepository } from './sqlite/chat-session.js';
import { SqliteChatSessionContextRepository } from './sqlite/chat-session-context.js';
import { SqliteChatMessageRepository } from './sqlite/chat-message.js';
import { SqliteChatSessionEventRepository } from './sqlite/chat-session-event.js';
import { InstanceConfigRepository } from './sqlite/instance-config.js';
import { NotificationChannelRepository } from './sqlite/notification-channel.js';
import { SqliteConnectorRepository } from './sqlite/connector.js';
import { PostgresInvestigationRepository } from './postgres/investigation.js';
import { PostgresIncidentRepository } from './postgres/incident.js';
import { PostgresFeedItemRepository } from './postgres/feed.js';
import { PostgresApprovalRequestRepository } from './postgres/approval.js';
import { PostgresShareLinkRepository } from './postgres/share.js';
import { DashboardRepository as PostgresDashboardRepository } from './postgres/dashboard.js';
import { PostgresFolderRepository } from './postgres/folder.js';
import { PostgresAlertRuleRepository } from './postgres/alert-rule.js';
import { PostgresNotificationRepository } from './postgres/notification.js';
import { PostgresVersionRepository } from './postgres/version.js';
import { PostgresInvestigationReportRepository } from './postgres/investigation-report.js';
import { PostgresPostMortemRepository } from './postgres/post-mortem.js';
import { PostgresChatSessionRepository } from './postgres/chat-session.js';
import { PostgresChatSessionContextRepository } from './postgres/chat-session-context.js';
import { PostgresChatMessageRepository } from './postgres/chat-message.js';
import { PostgresChatSessionEventRepository } from './postgres/chat-session-event.js';
import { PostgresInstanceConfigRepository } from './postgres/instance-config.js';
import { PostgresNotificationChannelRepository } from './postgres/notification-channel.js';
import { PostgresConnectorRepository } from './postgres/connector.js';
import { SqliteRemediationPlanRepository } from './sqlite/remediation-plan.js';
import { PostgresRemediationPlanRepository } from './postgres/remediation-plan.js';
import type { IRemediationPlanRepository } from './types/remediation-plan.js';
import type { INotificationDispatchRepository } from './types/notification-dispatch.js';
import { SqliteNotificationDispatchRepository } from './sqlite/notification-dispatch.js';
import { PostgresNotificationDispatchRepository } from './postgres/notification-dispatch.js';
import { SqliteLlmAuditRepository } from './sqlite/llm-audit-repository.js';
import { PostgresLlmAuditRepository } from './postgres/llm-audit-repository.js';
import type { ILlmAuditRepository } from './sqlite/llm-audit-repository.js';

/**
 * Complete repository bundle available behind every persistence backend.
 * Includes all entity types that were previously only available via in-memory stores.
 *
 * Investigation/incident/approval/share/dashboard/conversation repositories are
 * typed as intersections of the repository interface and the gateway store
 * interface — the SQLite classes implement both shapes so router factories that
 * only want the gateway surface can consume them directly without casts.
 */
export interface RepositoryBundle {
  investigations: SqliteInvestigationRepositoryInterface & IGatewayInvestigationStore;
  incidents: IIncidentRepository & IGatewayIncidentStore;
  feedItems: IFeedItemRepository;
  approvals: IApprovalRequestRepository & IGatewayApprovalStore;
  shares: IShareLinkRepository & IGatewayShareStore;
  dashboards: IDashboardRepository;
  folders: IFolderRepository;
  alertRules: IAlertRuleRepository;
  notifications: INotificationRepository;
  versions: IVersionRepository;
  investigationReports: IInvestigationReportRepository;
  postMortems: IPostMortemRepository;
  chatSessions: IChatSessionRepository;
  chatSessionContexts: IChatSessionContextRepository;
  chatMessages: IChatMessageRepository;
  chatSessionEvents: IChatSessionEventRepository;
  // W2 / T2.2 — instance-scoped config (replaces setup-config.json).
  instanceConfig: IInstanceConfigRepository;
  connectors: IConnectorRepository;
  notificationChannels: INotificationChannelRepository;
  remediationPlans: IRemediationPlanRepository;
  notificationDispatch: INotificationDispatchRepository;
  llmAudit: ILlmAuditRepository;
}

export function createSqliteRepositories(db: SqliteClient): RepositoryBundle {
  return {
    investigations: new InvestigationRepository(db),
    incidents: new SqliteIncidentRepository(db),
    feedItems: new SqliteFeedItemRepository(db),
    approvals: new SqliteApprovalRequestRepository(db),
    shares: new SqliteShareLinkRepository(db),
    dashboards: new SqliteDashboardRepository(db),
    folders: new SqliteFolderRepository(db),
    alertRules: new SqliteAlertRuleRepository(db),
    notifications: new SqliteNotificationRepository(db),
    versions: new SqliteVersionRepository(db),
    investigationReports: new SqliteInvestigationReportRepository(db),
    postMortems: new SqlitePostMortemRepository(db),
    chatSessions: new SqliteChatSessionRepository(db),
    chatSessionContexts: new SqliteChatSessionContextRepository(db),
    chatMessages: new SqliteChatMessageRepository(db),
    chatSessionEvents: new SqliteChatSessionEventRepository(db),
    instanceConfig: new InstanceConfigRepository(db),
    connectors: new SqliteConnectorRepository(db),
    notificationChannels: new NotificationChannelRepository(db),
    remediationPlans: new SqliteRemediationPlanRepository(db),
    notificationDispatch: new SqliteNotificationDispatchRepository(db),
    llmAudit: new SqliteLlmAuditRepository(db),
  };
}

export function createPostgresRepositories(db: DbClient): RepositoryBundle {
  const queryClient = db as QueryClient;
  return {
    investigations: new PostgresInvestigationRepository(queryClient) as RepositoryBundle['investigations'],
    incidents: new PostgresIncidentRepository(db),
    feedItems: new PostgresFeedItemRepository(db),
    approvals: new PostgresApprovalRequestRepository(db),
    shares: new PostgresShareLinkRepository(db),
    dashboards: new PostgresDashboardRepository(db),
    folders: new PostgresFolderRepository(db),
    alertRules: new PostgresAlertRuleRepository(db),
    notifications: new PostgresNotificationRepository(db),
    versions: new PostgresVersionRepository(db),
    investigationReports: new PostgresInvestigationReportRepository(db),
    postMortems: new PostgresPostMortemRepository(db),
    chatSessions: new PostgresChatSessionRepository(db),
    chatSessionContexts: new PostgresChatSessionContextRepository(db),
    chatMessages: new PostgresChatMessageRepository(db),
    chatSessionEvents: new PostgresChatSessionEventRepository(db),
    instanceConfig: new PostgresInstanceConfigRepository(queryClient),
    connectors: new PostgresConnectorRepository(queryClient),
    notificationChannels: new PostgresNotificationChannelRepository(queryClient),
    remediationPlans: new PostgresRemediationPlanRepository(db),
    notificationDispatch: new PostgresNotificationDispatchRepository(db),
    llmAudit: new PostgresLlmAuditRepository(db),
  };
}

