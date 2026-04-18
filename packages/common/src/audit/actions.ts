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
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export const AUDIT_ACTIONS: readonly string[] = Object.values(AuditAction);

export function isAuditAction(value: string): value is AuditActionValue {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
