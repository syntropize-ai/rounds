import type { DbClient } from '../db/client.js';
import type { SqliteClient } from '../db/sqlite-client.js';
import type { IInvestigationRepository, IIncidentRepository, IFeedRepository, ICaseRepository, IApprovalRepository, IShareRepository, IFeedItemRepository, IApprovalRequestRepository, IShareLinkRepository, IDashboardRepository, IConversationRepository, IFolderRepository, IAlertRuleRepository, INotificationRepository, IVersionRepository, IWorkspaceRepository, IInvestigationReportRepository, IPostMortemRepository } from './interfaces.js';
/**
 * Core repositories (shared across all backends that support them).
 */
export interface Repositories {
    investigations: IInvestigationRepository;
    incidents: IIncidentRepository;
    feed: IFeedRepository;
    cases: ICaseRepository;
    approvals: IApprovalRepository;
    shares: IShareRepository;
}
/**
 * Extended repositories available with the SQLite backend.
 * Includes all entity types that were previously only available via in-memory stores.
 */
export interface SqliteRepositories {
    investigations: IInvestigationRepository;
    incidents: IIncidentRepository;
    feedItems: IFeedItemRepository;
    approvals: IApprovalRequestRepository;
    shares: IShareLinkRepository;
    dashboards: IDashboardRepository;
    conversations: IConversationRepository;
    folders: IFolderRepository;
    alertRules: IAlertRuleRepository;
    notifications: INotificationRepository;
    versions: IVersionRepository;
    workspaces: IWorkspaceRepository;
    investigationReports: IInvestigationReportRepository;
    postMortems: IPostMortemRepository;
}
export declare function createInMemoryRepositories(): Repositories;
export declare function createPostgresRepositories(db: DbClient): Repositories;
export declare function createSqliteRepositories(db: SqliteClient): SqliteRepositories;
export type RepositoryBackend = 'memory' | 'postgres' | 'sqlite';
export declare function createRepositories(backend: RepositoryBackend, db?: DbClient): Repositories;
//# sourceMappingURL=factory.d.ts.map