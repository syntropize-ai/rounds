/**
 * Closed vocabulary of audit action strings.
 *
 * Every row written to `audit_log.action` must come from this enum — it lets
 * UIs filter with a known set and prevents typo drift in handler code.
 *
 * See docs/auth-perm-design/02-authentication.md §audit-action-vocabulary.
 * Dotted names follow Grafana Enterprise's auditor conventions — the strings
 * themselves (`user.login`, `team.member_added`) are operator-facing vocabulary.
 */

export const AuditAction = {
  // Authentication
  UserLogin: 'user.login',
  UserLoginFailed: 'user.login_failed',
  UserLogout: 'user.logout',

  // User lifecycle
  UserCreated: 'user.created',
  UserUpdated: 'user.updated',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  UserDeleted: 'user.deleted',
  UserRoleChanged: 'user.role_changed',
  UserPasswordChanged: 'user.password_changed',
  UserPasswordForceReset: 'user.password_force_reset',
  UserEmailChanged: 'user.email_changed',

  // External identity linking
  UserAuthLinked: 'user_auth.linked',
  UserAuthUnlinked: 'user_auth.unlinked',

  // Session tokens
  SessionRotated: 'session.rotated',
  SessionRevoked: 'session.revoked',

  // Org
  OrgCreated: 'org.created',
  OrgUpdated: 'org.updated',
  OrgDeleted: 'org.deleted',
  OrgUserAdded: 'org.user_added',
  OrgUserRemoved: 'org.user_removed',
  OrgUserRoleChanged: 'org.user_role_changed',

  // Teams
  TeamCreated: 'team.created',
  TeamUpdated: 'team.updated',
  TeamDeleted: 'team.deleted',
  TeamMemberAdded: 'team.member_added',
  TeamMemberRemoved: 'team.member_removed',

  // Roles
  RoleCreated: 'role.created',
  RoleUpdated: 'role.updated',
  RoleDeleted: 'role.deleted',
  RoleUserAssigned: 'role.user_assigned',
  RoleUserUnassigned: 'role.user_unassigned',
  RoleTeamAssigned: 'role.team_assigned',
  RoleTeamUnassigned: 'role.team_unassigned',

  // Service accounts
  ServiceAccountCreated: 'serviceaccount.created',
  ServiceAccountUpdated: 'serviceaccount.updated',
  ServiceAccountDeleted: 'serviceaccount.deleted',
  ServiceAccountTokenCreated: 'serviceaccount.token_created',
  ServiceAccountTokenRevoked: 'serviceaccount.token_revoked',

  // API keys (legacy / personal access tokens)
  ApiKeyCreated: 'apikey.created',
  ApiKeyRevoked: 'apikey.revoked',
  ApiKeyUsed: 'apikey.used',

  // Resource permissions
  PermissionGranted: 'permission.granted',
  PermissionRevoked: 'permission.revoked',

  // Agent tool invocations (Wave 7)
  AgentToolCalled: 'agent.tool_called',
  AgentToolDenied: 'agent.tool_denied',

  // Instance config (W2 / T2.4 — setup wizard + system settings)
  InstanceLlmUpdated: 'instance.llm_updated',
  InstanceLlmCleared: 'instance.llm_cleared',
  DatasourceCreated: 'datasource.created',
  DatasourceUpdated: 'datasource.updated',
  DatasourceDeleted: 'datasource.deleted',
  NotificationChannelCreated: 'notification_channel.created',
  NotificationChannelUpdated: 'notification_channel.updated',
  NotificationChannelDeleted: 'notification_channel.deleted',
  InstanceBootstrapped: 'instance.bootstrapped',

  // Resource mutations (Wave 1 — enables downstream RFCs for My Workspace
  // promote, provisioned protection, service attribution confirm).
  // See docs/design/rfc-safety-patterns.md.
  DashboardCreate: 'dashboard.create',
  DashboardUpdate: 'dashboard.update',
  DashboardDelete: 'dashboard.delete',
  DashboardMove: 'dashboard.move',
  DashboardFork: 'dashboard.fork',
  DashboardPromote: 'dashboard.promote',
  FolderCreate: 'folder.create',
  FolderUpdate: 'folder.update',
  FolderDelete: 'folder.delete',
  AlertRuleCreate: 'alert_rule.create',
  AlertRuleUpdate: 'alert_rule.update',
  AlertRuleDelete: 'alert_rule.delete',
  // Wave 2 step 1 — promotion of a personal draft alert rule into a
  // shared/team folder. Crosses a permission boundary; written by the
  // promote handler in addition to the GuardedAction audit.
  AlertRulePromote: 'alert_rule.promote',
  AlertRuleFork: 'alert_rule.fork',
  InvestigationCreate: 'investigation.create',
  InvestigationUpdate: 'investigation.update',
  ServiceAttributionConfirm: 'service.attribution_confirm',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export const AUDIT_ACTIONS: readonly string[] = Object.values(AuditAction);

export function isAuditAction(value: string): value is AuditActionValue {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
