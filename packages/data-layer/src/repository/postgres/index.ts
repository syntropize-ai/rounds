export { PostgresInvestigationRepository } from './investigation.js';
export { PostgresIncidentRepository } from './incident.js';
export { PostgresFeedRepository } from './feed.js';
export { PostgresCaseRepository } from './case.js';
export { PostgresApprovalRepository } from './approval.js';
export { PostgresShareRepository } from './share.js';

// W2 / T6.B — instance-scoped config on Postgres. The W6 stores (dashboards,
// investigations, alert rules) remain SQLite-only for this sprint; see
// ./README.md for the rationale.
export { PostgresInstanceConfigRepository } from './instance-config.js';
export { PostgresDatasourceRepository } from './datasource.js';
export { PostgresNotificationChannelRepository } from './notification-channel.js';
export { applyPostgresInstanceMigrations } from './migrate.js';
