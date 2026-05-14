// Complete repository set for the Postgres backend. Keep this barrel focused on
// Postgres implementations so callers can select a backend at the factory edge.
export * as postgresAuth from './auth/index.js';
export { PostgresInvestigationRepository } from './investigation.js';
export { PostgresIncidentRepository } from './incident.js';
export { PostgresFeedItemRepository } from './feed.js';
export { PostgresApprovalRequestRepository } from './approval.js';
export { PostgresShareLinkRepository } from './share.js';
export { DashboardRepository as PostgresDashboardRepository } from './dashboard.js';
export { PostgresFolderRepository } from './folder.js';
export { PostgresInvestigationReportRepository } from './investigation-report.js';
export { PostgresPostMortemRepository } from './post-mortem.js';
export { PostgresAlertRuleRepository } from './alert-rule.js';
export { PostgresNotificationRepository } from './notification.js';
export { PostgresVersionRepository } from './version.js';
export { PostgresChatSessionRepository } from './chat-session.js';
export { PostgresChatSessionContextRepository } from './chat-session-context.js';
export { PostgresChatMessageRepository } from './chat-message.js';
export { PostgresChatSessionEventRepository } from './chat-session-event.js';
export { PostgresInstanceConfigRepository } from './instance-config.js';
export { PostgresNotificationChannelRepository } from './notification-channel.js';
export { PostgresConnectorRepository } from './connector.js';
export { applyPostgresSchema } from './schema-applier.js';

export { PostgresRemediationPlanRepository } from './remediation-plan.js';
