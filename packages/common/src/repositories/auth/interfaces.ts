/**
 * Repository interfaces for the Grafana-parity auth/perm entities.
 *
 * See docs/auth-perm-design/ for design. One `<Entity>Repository` per table —
 * implementations live in `packages/data-layer/src/repository/auth/`.
 */

import type {
  User,
  NewUser,
  UserPatch,
  UserAuth,
  NewUserAuth,
  UserAuthToken,
  NewUserAuthToken,
} from '../../models/user.js';
import type { Org, NewOrg, OrgPatch, OrgUser, NewOrgUser, OrgRole } from '../../models/org.js';
import type { Team, NewTeam, TeamPatch, TeamMember, NewTeamMember, TeamMemberPermission } from '../../models/team.js';
import type { ApiKey, NewApiKey, ApiKeyPatch } from '../../models/api-key.js';
import type {
  Role,
  NewRole,
  RolePatch,
  Permission,
  NewPermission,
  BuiltinRole,
  NewBuiltinRole,
  UserRole,
  NewUserRole,
  TeamRole,
  NewTeamRole,
} from '../../models/rbac.js';
import type { GrafanaFolder, NewGrafanaFolder, GrafanaFolderPatch } from '../../models/folder.js';
import type { DashboardAcl, NewDashboardAcl } from '../../models/dashboard-acl.js';
import type { Preferences, NewPreferences, PreferencesPatch } from '../../models/preferences.js';
import type { Quota, NewQuota } from '../../models/quota.js';
import type { AuditLogEntry, NewAuditLogEntry, AuditLogQuery } from '../../models/audit-log.js';

// — Common types ————————————————————————————————————————————————

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

// — User ————————————————————————————————————————————————————————

export interface ListUsersOptions extends ListOptions {
  orgId?: string;
  isServiceAccount?: boolean;
  isDisabled?: boolean;
  search?: string;
}

export interface IUserRepository {
  create(input: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByLogin(login: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /**
   * Resolve user by external auth binding (oauth_github:1234, saml:uid, ...).
   * Returns null when no matching `user_auth` row exists.
   */
  findByAuthInfo(authModule: string, authId: string): Promise<User | null>;
  list(opts?: ListUsersOptions): Promise<Page<User>>;
  update(id: string, patch: UserPatch): Promise<User | null>;
  delete(id: string): Promise<boolean>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
  updateLastSeen(id: string, at: string): Promise<void>;
  countServiceAccounts(orgId: string): Promise<number>;
}

// — UserAuth ———————————————————————————————————————————————————

export interface IUserAuthRepository {
  create(input: NewUserAuth): Promise<UserAuth>;
  findById(id: string): Promise<UserAuth | null>;
  findByAuthInfo(authModule: string, authId: string): Promise<UserAuth | null>;
  listByUser(userId: string): Promise<UserAuth[]>;
  update(id: string, patch: Partial<Omit<UserAuth, 'id' | 'userId' | 'created'>>): Promise<UserAuth | null>;
  delete(id: string): Promise<boolean>;
  deleteByUser(userId: string): Promise<number>;
}

// — UserAuthToken ——————————————————————————————————————————————

export interface IUserAuthTokenRepository {
  create(input: NewUserAuthToken): Promise<UserAuthToken>;
  findById(id: string): Promise<UserAuthToken | null>;
  /**
   * Look up a live token (revokedAt IS NULL) matching either `auth_token` or
   * `prev_auth_token`. Used at every authenticated request. Returns null if
   * the token is unknown, or revoked.
   */
  findByHashedToken(hashedToken: string): Promise<UserAuthToken | null>;
  listByUser(userId: string, includeRevoked?: boolean): Promise<UserAuthToken[]>;
  /** Rotate: atomically set auth_token = newHash, prev_auth_token = oldHash. */
  rotate(id: string, newHashedToken: string, rotatedAt: string): Promise<UserAuthToken | null>;
  markSeen(id: string, seenAt: string): Promise<void>;
  revoke(id: string, revokedAt: string): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: string): Promise<number>;
  deleteExpired(before: string): Promise<number>;
}

// — Org —————————————————————————————————————————————————————————

export interface IOrgRepository {
  create(input: NewOrg): Promise<Org>;
  findById(id: string): Promise<Org | null>;
  findByName(name: string): Promise<Org | null>;
  list(opts?: ListOptions): Promise<Page<Org>>;
  update(id: string, patch: OrgPatch): Promise<Org | null>;
  delete(id: string): Promise<boolean>;
}

// — OrgUser ————————————————————————————————————————————————————

export interface ListOrgUsersOptions extends ListOptions {
  search?: string;
}

export interface OrgUserWithProfile extends OrgUser {
  email: string;
  name: string;
  login: string;
  isServiceAccount: boolean;
}

export interface IOrgUserRepository {
  create(input: NewOrgUser): Promise<OrgUser>;
  findById(id: string): Promise<OrgUser | null>;
  findMembership(orgId: string, userId: string): Promise<OrgUser | null>;
  listUsersByOrg(orgId: string, opts?: ListOrgUsersOptions): Promise<Page<OrgUserWithProfile>>;
  listOrgsByUser(userId: string): Promise<OrgUser[]>;
  updateRole(orgId: string, userId: string, role: OrgRole): Promise<OrgUser | null>;
  remove(orgId: string, userId: string): Promise<boolean>;
}

// — Team ———————————————————————————————————————————————————————

export interface ListTeamsOptions extends ListOptions {
  search?: string;
}

export interface ITeamRepository {
  create(input: NewTeam): Promise<Team>;
  findById(id: string): Promise<Team | null>;
  findByName(orgId: string, name: string): Promise<Team | null>;
  listByOrg(orgId: string, opts?: ListTeamsOptions): Promise<Page<Team>>;
  update(id: string, patch: TeamPatch): Promise<Team | null>;
  delete(id: string): Promise<boolean>;
}

// — TeamMember ———————————————————————————————————————————————

export interface ITeamMemberRepository {
  create(input: NewTeamMember): Promise<TeamMember>;
  findById(id: string): Promise<TeamMember | null>;
  findMembership(teamId: string, userId: string): Promise<TeamMember | null>;
  listByTeam(teamId: string): Promise<TeamMember[]>;
  listTeamsForUser(userId: string, orgId?: string): Promise<TeamMember[]>;
  updatePermission(teamId: string, userId: string, permission: TeamMemberPermission): Promise<TeamMember | null>;
  remove(teamId: string, userId: string): Promise<boolean>;
  removeAllByUser(userId: string): Promise<number>;
}

// — ApiKey —————————————————————————————————————————————————————

export interface ListApiKeysOptions extends ListOptions {
  orgId?: string;
  serviceAccountId?: string | null;
  includeRevoked?: boolean;
  includeExpired?: boolean;
}

export interface IApiKeyRepository {
  create(input: NewApiKey): Promise<ApiKey>;
  findById(id: string): Promise<ApiKey | null>;
  /** Resolve by SHA-256 hex. Returns null when unknown or revoked. */
  findByHashedKey(hashedKey: string): Promise<ApiKey | null>;
  list(opts?: ListApiKeysOptions): Promise<Page<ApiKey>>;
  update(id: string, patch: ApiKeyPatch): Promise<ApiKey | null>;
  revoke(id: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /** Update last_used_at to `at` (ISO-8601). Silently no-ops on unknown id. */
  touchLastUsed(id: string, at: string): Promise<void>;
}

// — Role —————————————————————————————————————————————————————————

export interface ListRolesOptions extends ListOptions {
  orgId?: string;
  includeGlobal?: boolean;
  hidden?: boolean;
}

export interface IRoleRepository {
  create(input: NewRole): Promise<Role>;
  findById(id: string): Promise<Role | null>;
  findByUid(orgId: string, uid: string): Promise<Role | null>;
  findByName(orgId: string, name: string): Promise<Role | null>;
  list(opts?: ListRolesOptions): Promise<Page<Role>>;
  update(id: string, patch: RolePatch): Promise<Role | null>;
  delete(id: string): Promise<boolean>;

  // builtin_role helpers
  upsertBuiltinRole(input: NewBuiltinRole): Promise<BuiltinRole>;
  listBuiltinRoles(orgId: string): Promise<BuiltinRole[]>;
  findBuiltinRole(role: string, orgId: string, roleId: string): Promise<BuiltinRole | null>;
  removeBuiltinRole(role: string, orgId: string, roleId: string): Promise<boolean>;
}

// — Permission ——————————————————————————————————————————————————

export interface IPermissionRepository {
  create(input: NewPermission): Promise<Permission>;
  createMany(inputs: NewPermission[]): Promise<Permission[]>;
  findById(id: string): Promise<Permission | null>;
  listByRole(roleId: string): Promise<Permission[]>;
  listByRoles(roleIds: string[]): Promise<Permission[]>;
  listByAction(action: string): Promise<Permission[]>;
  delete(id: string): Promise<boolean>;
  deleteByRole(roleId: string): Promise<number>;
}

// — UserRole ——————————————————————————————————————————————————

export interface IUserRoleRepository {
  create(input: NewUserRole): Promise<UserRole>;
  findById(id: string): Promise<UserRole | null>;
  listByUser(userId: string, orgId?: string): Promise<UserRole[]>;
  listByRole(roleId: string): Promise<UserRole[]>;
  delete(id: string): Promise<boolean>;
  remove(orgId: string, userId: string, roleId: string): Promise<boolean>;
}

// — TeamRole ——————————————————————————————————————————————————

export interface ITeamRoleRepository {
  create(input: NewTeamRole): Promise<TeamRole>;
  findById(id: string): Promise<TeamRole | null>;
  listByTeam(teamId: string, orgId?: string): Promise<TeamRole[]>;
  listByTeams(teamIds: string[], orgId?: string): Promise<TeamRole[]>;
  listByRole(roleId: string): Promise<TeamRole[]>;
  delete(id: string): Promise<boolean>;
  remove(orgId: string, teamId: string, roleId: string): Promise<boolean>;
}

// — Folder ————————————————————————————————————————————————————

export interface ListFoldersOptions extends ListOptions {
  orgId: string;
  parentUid?: string | null;
}

export interface IFolderRepository {
  create(input: NewGrafanaFolder): Promise<GrafanaFolder>;
  findById(id: string): Promise<GrafanaFolder | null>;
  findByUid(orgId: string, uid: string): Promise<GrafanaFolder | null>;
  list(opts: ListFoldersOptions): Promise<Page<GrafanaFolder>>;
  /** List the ancestor chain of `uid` from the direct parent up to the root. */
  listAncestors(orgId: string, uid: string): Promise<GrafanaFolder[]>;
  listChildren(orgId: string, parentUid: string | null): Promise<GrafanaFolder[]>;
  update(id: string, patch: GrafanaFolderPatch): Promise<GrafanaFolder | null>;
  delete(id: string): Promise<boolean>;
}

// — DashboardAcl ——————————————————————————————————————————————

export interface IDashboardAclRepository {
  create(input: NewDashboardAcl): Promise<DashboardAcl>;
  findById(id: string): Promise<DashboardAcl | null>;
  listByDashboard(dashboardId: string): Promise<DashboardAcl[]>;
  listByFolder(folderId: string): Promise<DashboardAcl[]>;
  listByUser(orgId: string, userId: string): Promise<DashboardAcl[]>;
  listByTeam(orgId: string, teamId: string): Promise<DashboardAcl[]>;
  delete(id: string): Promise<boolean>;
  deleteByDashboard(dashboardId: string): Promise<number>;
  deleteByFolder(folderId: string): Promise<number>;
}

// — Preferences ————————————————————————————————————————————————

export interface IPreferencesRepository {
  upsert(input: NewPreferences): Promise<Preferences>;
  findOrgPrefs(orgId: string): Promise<Preferences | null>;
  findUserPrefs(orgId: string, userId: string): Promise<Preferences | null>;
  findTeamPrefs(orgId: string, teamId: string): Promise<Preferences | null>;
  update(id: string, patch: PreferencesPatch): Promise<Preferences | null>;
  delete(id: string): Promise<boolean>;
}

// — Quota ——————————————————————————————————————————————————————

export interface IQuotaRepository {
  upsertOrgQuota(orgId: string, target: string, limitVal: number): Promise<Quota>;
  upsertUserQuota(userId: string, target: string, limitVal: number): Promise<Quota>;
  findOrgQuota(orgId: string, target: string): Promise<Quota | null>;
  findUserQuota(userId: string, target: string): Promise<Quota | null>;
  listOrgQuotas(orgId: string): Promise<Quota[]>;
  listUserQuotas(userId: string): Promise<Quota[]>;
  delete(id: string): Promise<boolean>;
  create(input: NewQuota): Promise<Quota>;
}

// — AuditLog ——————————————————————————————————————————————————

export interface IAuditLogRepository {
  log(entry: NewAuditLogEntry): Promise<AuditLogEntry>;
  findById(id: string): Promise<AuditLogEntry | null>;
  query(opts?: AuditLogQuery): Promise<Page<AuditLogEntry>>;
  /** Retention: delete rows with timestamp < before. */
  deleteOlderThan(before: string): Promise<number>;
}
