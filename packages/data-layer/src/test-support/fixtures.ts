import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../db/sqlite-client.js';
import type {
  User,
  NewUser,
  Org,
  NewOrg,
  OrgUser,
  OrgRole,
  Team,
  NewTeam,
  TeamMember,
  NewTeamMember,
  ApiKey,
  NewApiKey,
  Role,
  NewRole,
  Permission,
  NewPermission,
  GrafanaFolder,
  NewGrafanaFolder,
  AuditLogEntry,
  NewAuditLogEntry,
} from '@agentic-obs/common';
import { TEAM_MEMBER_PERMISSION_MEMBER } from '@agentic-obs/common';
import { OrgRepository } from '../repository/auth/org-repository.js';
import { UserRepository } from '../repository/auth/user-repository.js';
import { OrgUserRepository } from '../repository/auth/org-user-repository.js';
import { TeamRepository } from '../repository/auth/team-repository.js';
import { TeamMemberRepository } from '../repository/auth/team-member-repository.js';
import { ApiKeyRepository } from '../repository/auth/api-key-repository.js';
import { RoleRepository } from '../repository/auth/role-repository.js';
import { PermissionRepository } from '../repository/auth/permission-repository.js';
import { FolderRepository } from '../repository/auth/folder-repository.js';
import { AuditLogRepository } from '../repository/auth/audit-log-repository.js';
// Wave 2 (T3.1): full RBAC data seeding — inserts every built-in + fixed role
// plus their permissions. Imported here so test harnesses get a realistic
// permission catalog out of the box.
import { seedRbacForOrg } from '../seed/rbac-seed.js';

/**
 * Fixture builders + DB seeders for the Grafana-parity auth/perm entities.
 *
 * The `make*` helpers return plain object literals that satisfy the domain
 * types — useful for tests that need a realistic object without hitting the
 * DB. The `seed*` helpers actually insert rows via a SqliteClient.
 *
 * Design note: `seedBuiltinRoles` creates the role and builtin_role skeletons
 * only. Populating permission rows for those roles is T3.1's responsibility,
 * not T1.3 — that lives in `packages/data-layer/src/seed/rbac-seed.ts`.
 */

// — Pure object builders (no DB) —————————————————————————————————————

const nowIso = () => new Date().toISOString();
const uid = () => randomUUID();

export function makeOrg(overrides: Partial<Org> = {}): Org {
  const now = nowIso();
  return {
    id: overrides.id ?? `org_${uid().slice(0, 8)}`,
    version: 0,
    name: 'Fixture Org',
    created: now,
    updated: now,
    ...overrides,
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  const now = nowIso();
  const id = overrides.id ?? `user_${uid().slice(0, 8)}`;
  return {
    id,
    version: 0,
    email: `${id}@example.test`,
    name: 'Fixture User',
    login: id,
    password: null,
    salt: null,
    rands: null,
    company: null,
    orgId: 'org_main',
    isAdmin: false,
    emailVerified: false,
    theme: null,
    helpFlags1: 0,
    isDisabled: false,
    isServiceAccount: false,
    created: now,
    updated: now,
    lastSeenAt: null,
    ...overrides,
  };
}

export function makeServiceAccount(orgId: string, overrides: Partial<User> = {}): User {
  const id = overrides.id ?? `sa_${uid().slice(0, 8)}`;
  return makeUser({
    id,
    login: id,
    email: `${id}@svc.rounds.local`,
    name: 'Fixture Service Account',
    orgId,
    isServiceAccount: true,
    password: null,
    ...overrides,
  });
}

export function makeOrgUser(orgId: string, userId: string, role: OrgRole): OrgUser {
  const now = nowIso();
  return {
    id: `ou_${uid().slice(0, 8)}`,
    orgId,
    userId,
    role,
    created: now,
    updated: now,
  };
}

export function makeTeam(orgId: string, overrides: Partial<Team> = {}): Team {
  const now = nowIso();
  return {
    id: overrides.id ?? `team_${uid().slice(0, 8)}`,
    orgId,
    name: 'Fixture Team',
    email: null,
    external: false,
    created: now,
    updated: now,
    ...overrides,
  };
}

export function makeTeamMember(
  orgId: string,
  teamId: string,
  userId: string,
  overrides: Partial<TeamMember> = {},
): TeamMember {
  const now = nowIso();
  return {
    id: overrides.id ?? `tm_${uid().slice(0, 8)}`,
    orgId,
    teamId,
    userId,
    external: false,
    permission: TEAM_MEMBER_PERMISSION_MEMBER,
    created: now,
    updated: now,
    ...overrides,
  };
}

export function makeApiKey(orgId: string, overrides: Partial<ApiKey> = {}): ApiKey {
  const now = nowIso();
  return {
    id: overrides.id ?? `apikey_${uid().slice(0, 8)}`,
    orgId,
    name: 'Fixture API Key',
    key: `sha256_${uid().replace(/-/g, '')}`,
    role: 'Viewer',
    created: now,
    updated: now,
    lastUsedAt: null,
    expires: null,
    serviceAccountId: null,
    ownerUserId: null,
    isRevoked: false,
    ...overrides,
  };
}

export function makeRole(orgId: string, overrides: Partial<Role> = {}): Role {
  const now = nowIso();
  const name = overrides.name ?? `fixed:fixture:role_${uid().slice(0, 6)}`;
  return {
    id: overrides.id ?? `role_${uid().slice(0, 8)}`,
    version: 0,
    orgId,
    name,
    uid: overrides.uid ?? name.replace(/:/g, '_'),
    displayName: 'Fixture Role',
    description: null,
    groupName: null,
    hidden: false,
    created: now,
    updated: now,
    ...overrides,
  };
}

export function makePermission(roleId: string, action: string, scope = ''): Permission {
  const now = nowIso();
  const parts = scope.split(':');
  const kind = parts[0] || '*';
  const attribute = parts[1] || '*';
  const identifier = parts.length >= 3 ? parts.slice(2).join(':') : '*';
  return {
    id: `perm_${uid().slice(0, 8)}`,
    roleId,
    action,
    scope,
    kind: scope === '' ? '*' : kind,
    attribute: scope === '' ? '*' : attribute,
    identifier: scope === '' ? '*' : identifier,
    created: now,
    updated: now,
  };
}

export function makeFolder(orgId: string, overrides: Partial<GrafanaFolder> = {}): GrafanaFolder {
  const now = nowIso();
  const id = overrides.id ?? `folder_${uid().slice(0, 8)}`;
  return {
    id,
    uid: overrides.uid ?? id,
    orgId,
    title: 'Fixture Folder',
    description: null,
    parentUid: null,
    kind: 'shared',
    created: now,
    updated: now,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

export function makeAuditLog(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  const now = nowIso();
  return {
    id: overrides.id ?? `audit_${uid().slice(0, 8)}`,
    timestamp: now,
    action: 'user.login',
    actorType: 'user',
    actorId: null,
    actorName: null,
    orgId: null,
    targetType: null,
    targetId: null,
    targetName: null,
    outcome: 'success',
    metadata: null,
    ip: null,
    userAgent: null,
    ...overrides,
  };
}

// — DB seeders ——————————————————————————————————————————————————————

export interface ServerAdminOptions {
  email?: string;
  login?: string;
  name?: string;
  /** scrypt hash (salt-embedded). If the caller stores real passwords, pass the
   *  encoded hash here — the seeder does not hash plaintext. */
  password?: string | null;
}

/**
 * Ensure `org_main` exists. Migration 001 already inserts it, but callers may
 * want to re-assert + get a typed Org back.
 */
export async function seedDefaultOrg(db: SqliteClient): Promise<Org> {
  const repo = new OrgRepository(db);
  const existing = await repo.findById('org_main');
  if (existing) return existing;
  return repo.create({ id: 'org_main', name: 'Main Org' });
}

/**
 * Seed a server-admin user into the default org with role Admin. Idempotent
 * on login — reuses an existing user with the same login if one exists.
 */
export async function seedServerAdmin(
  db: SqliteClient,
  opts: ServerAdminOptions = {},
): Promise<{ user: User; orgUser: OrgUser }> {
  await seedDefaultOrg(db);
  const login = opts.login ?? 'admin';
  const email = opts.email ?? 'admin@rounds.local';
  const userRepo = new UserRepository(db);
  const orgUserRepo = new OrgUserRepository(db);

  let user = await userRepo.findByLogin(login);
  if (!user) {
    const input: NewUser = {
      email,
      name: opts.name ?? 'Server Admin',
      login,
      password: opts.password ?? null,
      orgId: 'org_main',
      isAdmin: true,
      emailVerified: true,
    };
    user = await userRepo.create(input);
  }

  let orgUser = await orgUserRepo.findMembership('org_main', user.id);
  if (!orgUser) {
    orgUser = await orgUserRepo.create({
      orgId: 'org_main',
      userId: user.id,
      role: 'Admin',
    });
  }
  return { user, orgUser };
}

/**
 * Seed the three per-org basic roles (basic:viewer / editor / admin), the
 * global basic:server_admin, their builtin_role linkages, AND every fixed
 * role + every permission row — i.e. a fully populated RBAC catalog for
 * `orgId`.
 *
 * Wave 2 (T3.1) expanded this beyond the T1 "skeleton only" behavior — we
 * now delegate to `seedRbacForOrg` which populates permissions as well.
 * Existing callers still get the four typed role rows back as a convenience.
 */
export async function seedBuiltinRoles(
  db: SqliteClient,
  orgId: string,
): Promise<{ viewerRole: Role; editorRole: Role; adminRole: Role; serverAdminRole: Role }> {
  await seedRbacForOrg(db, orgId);

  const roleRepo = new RoleRepository(db);
  const viewer = await roleRepo.findByUid(orgId, 'basic_viewer');
  const editor = await roleRepo.findByUid(orgId, 'basic_editor');
  const admin = await roleRepo.findByUid(orgId, 'basic_admin');
  const serverAdmin = await roleRepo.findByUid('', 'basic_server_admin');

  if (!viewer || !editor || !admin || !serverAdmin) {
    throw new Error(
      '[seedBuiltinRoles] expected rows missing after seedRbacForOrg — internal invariant broken',
    );
  }

  return {
    viewerRole: viewer,
    editorRole: editor,
    adminRole: admin,
    serverAdminRole: serverAdmin,
  };
}

/**
 * Convenience: wipe every auth-perm table. Useful between tests in a shared
 * DB. Not used for per-test isolation (in-memory DBs suffice for that); kept
 * as an escape hatch for longer-lived test harnesses.
 */
export function resetAuthTables(db: SqliteClient): void {
  const tables = [
    'audit_log',
    'quota',
    'preferences',
    'dashboard_acl',
    'folder',
    'team_role',
    'user_role',
    'builtin_role',
    'permission',
    'role',
    'api_key',
    'team_member',
    'team',
    'org_user',
    'user_auth_token',
    'user_auth',
    'user',
    'org',
  ];
  for (const t of tables) {
    db.run(sql.raw(`DELETE FROM ${t}`));
  }
}

// — Re-exports so callers only need to import from fixtures.ts ——————

export {
  OrgRepository,
  UserRepository,
  OrgUserRepository,
  TeamRepository,
  TeamMemberRepository,
  ApiKeyRepository,
  RoleRepository,
  PermissionRepository,
  FolderRepository,
  AuditLogRepository,
};

export type {
  NewOrg,
  NewUser,
  NewTeam,
  NewTeamMember,
  NewApiKey,
  NewRole,
  NewPermission,
  NewGrafanaFolder,
  NewAuditLogEntry,
};
