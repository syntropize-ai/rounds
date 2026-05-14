/**
 * In-memory repository implementations. Test-fixture only — production
 * wiring uses the SQLite or Postgres repositories (see ADR-001).
 */

export { InMemoryAlertRuleRepository } from './alert-rule.js';
export { InMemoryDashboardRepository } from './dashboard.js';
