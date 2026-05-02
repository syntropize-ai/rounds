import type { SqliteClient } from '../db/sqlite-client.js';
import type { DbClient } from '../db/client.js';
import type { QueryClient } from '../db/query-client.js';
import type {
  IIncidentRepository,
  IFeedItemRepository,
  IApprovalRequestRepository,
  IShareLinkRepository,
  IDashboardRepository,
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
  IInstanceConfigRepository,
  IDatasourceRepository,
  INotificationChannelRepository,
} from '@agentic-obs/common';
import type { IOpsConnectorRepository } from './types/ops-connector.js';
import type {
  IGatewayInvestigationStore,
  IGatewayIncidentStore,
  IGatewayApprovalStore,
  IGatewayShareStore,
  IGatewayDashboardStore,
} from '../stores/interfaces.js';

import { InvestigationRepository } from './sqlite/investigation.js';
import { SqliteIncidentRepository } from './sqlite/incident.js';
import { SqliteFeedItemRepository } from './sqlite/feed.js';
import { SqliteApprovalRequestRepository } from './sqlite/approval.js';
import { SqliteShareLinkRepository } from './sqlite/share.js';
import { SqliteDashboardRepository } from './sqlite/dashboard.js';
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
import { DatasourceRepository } from './sqlite/datasource.js';
import { NotificationChannelRepository } from './sqlite/notification-channel.js';
import { OpsConnectorRepository } from './sqlite/ops-connector.js';
import { SqliteChangeSourceRepository } from './sqlite/change-source.js';
import { PostgresInvestigationRepository } from './postgres/investigation.js';
import { PostgresIncidentRepository } from './postgres/incident.js';
import { PostgresFeedItemRepository } from './postgres/feed.js';
import { PostgresApprovalRequestRepository } from './postgres/approval.js';
import { PostgresShareLinkRepository } from './postgres/share.js';
import { PostgresDashboardRepository } from './postgres/dashboard.js';
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
import { PostgresDatasourceRepository } from './postgres/datasource.js';
import { PostgresNotificationChannelRepository } from './postgres/notification-channel.js';
import { PostgresOpsConnectorRepository } from './postgres/ops-connector.js';
import { PostgresChangeSourceRepository } from './postgres/change-source.js';
import { SqliteRemediationPlanRepository } from './sqlite/remediation-plan.js';
import { PostgresRemediationPlanRepository } from './postgres/remediation-plan.js';
import type { IRemediationPlanRepository } from './types/remediation-plan.js';
import type { IChangeSourceRepository } from './types/change-source.js';

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
  dashboards: IDashboardRepository & IGatewayDashboardStore;
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
  datasources: IDatasourceRepository;
  notificationChannels: INotificationChannelRepository;
  opsConnectors: IOpsConnectorRepository;
  changeSources: IChangeSourceRepository;
  remediationPlans: IRemediationPlanRepository;
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
    datasources: new DatasourceRepository(db),
    notificationChannels: new NotificationChannelRepository(db),
    opsConnectors: new OpsConnectorRepository(db),
    changeSources: new SqliteChangeSourceRepository(db),
    remediationPlans: new SqliteRemediationPlanRepository(db),
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
    datasources: new PostgresDatasourceRepository(queryClient),
    notificationChannels: new PostgresNotificationChannelRepository(queryClient),
    opsConnectors: new PostgresOpsConnectorRepository(db),
    changeSources: new PostgresChangeSourceRepository(queryClient),
    remediationPlans: new PostgresRemediationPlanRepository(db),
  };
}

/** @deprecated Use RepositoryBundle. */
export type SqliteRepositories = RepositoryBundle;
