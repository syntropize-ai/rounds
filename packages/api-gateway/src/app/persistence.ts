/**
 * Persistence backend selection.
 *
 * The API gateway depends on repository bundles plus a small raw query runner.
 * SQLite and Postgres are implementations of that boundary; no route or
 * service should branch on the concrete database.
 */

import {
  ApiKeyRepository,
  AuditLogRepository,
  DashboardAclRepository,
  FolderRepository,
  OrgRepository,
  OrgUserRepository,
  PermissionRepository,
  PreferencesRepository,
  QuotaRepository,
  RoleRepository,
  TeamMemberRepository,
  TeamRepository,
  TeamRoleRepository,
  UserAuthRepository,
  UserAuthTokenRepository,
  UserRepository,
  UserRoleRepository,
  applyPostgresSchema,
  applySchema,
  createDbClient,
  createPostgresRepositories,
  createSqliteClient,
  createSqliteRepositories,
  postgresAuth,
} from '@agentic-obs/data-layer';
import type { DbClient, QueryClient, RepositoryBundle, SqliteClient } from '@agentic-obs/data-layer';
import type {
  IApiKeyRepository,
  IAuditLogRepository,
  IDashboardAclRepository,
  IFolderRepository,
  IOrgRepository,
  IOrgUserRepository,
  IPermissionRepository,
  IPreferencesRepository,
  IQuotaRepository,
  IRoleRepository,
  ITeamMemberRepository,
  ITeamRepository,
  ITeamRoleRepository,
  IUserAuthRepository,
  IUserAuthTokenRepository,
  IUserRepository,
  IUserRoleRepository,
} from '@agentic-obs/common';
import { dbPath } from '../paths.js';
import { sql } from 'drizzle-orm';
import { setDatabaseProbe } from '../routes/health.js';

export type PersistenceBackend = 'sqlite' | 'postgres';

export interface AuthRepositoryBundle {
  users: IUserRepository;
  userAuth: IUserAuthRepository;
  userAuthTokens: IUserAuthTokenRepository;
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
  auditLog: IAuditLogRepository;
  apiKeys: IApiKeyRepository;
  preferences: IPreferencesRepository;
}

export interface RbacRepositoryBundle {
  roles: IRoleRepository;
  permissions: IPermissionRepository;
  userRoles: IUserRoleRepository;
  teamRoles: ITeamRoleRepository;
  teamMembers: ITeamMemberRepository;
  folders: IFolderRepository;
  dashboardAcl: IDashboardAclRepository;
  quotas: IQuotaRepository;
  teams: ITeamRepository;
}

export interface Persistence {
  backend: PersistenceBackend;
  db: QueryClient;
  repos: RepositoryBundle;
  authRepos: AuthRepositoryBundle;
  rbacRepos: RbacRepositoryBundle;
}

function isPostgresUrl(
  url: string | undefined,
): url is `postgres://${string}` | `postgresql://${string}` {
  return (
    typeof url === 'string' &&
    (url.startsWith('postgres://') || url.startsWith('postgresql://'))
  );
}

function createSqliteAuthRepositories(db: SqliteClient): AuthRepositoryBundle {
  return {
    users: new UserRepository(db),
    userAuth: new UserAuthRepository(db),
    userAuthTokens: new UserAuthTokenRepository(db),
    orgs: new OrgRepository(db),
    orgUsers: new OrgUserRepository(db),
    auditLog: new AuditLogRepository(db),
    apiKeys: new ApiKeyRepository(db),
    preferences: new PreferencesRepository(db),
  };
}

function createSqliteRbacRepositories(db: SqliteClient): RbacRepositoryBundle {
  return {
    roles: new RoleRepository(db),
    permissions: new PermissionRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    teamMembers: new TeamMemberRepository(db),
    folders: new FolderRepository(db),
    dashboardAcl: new DashboardAclRepository(db),
    quotas: new QuotaRepository(db),
    teams: new TeamRepository(db),
  };
}

function createPostgresAuthRepositories(db: DbClient): AuthRepositoryBundle {
  return {
    users: new postgresAuth.UserRepository(db),
    userAuth: new postgresAuth.UserAuthRepository(db),
    userAuthTokens: new postgresAuth.UserAuthTokenRepository(db),
    orgs: new postgresAuth.OrgRepository(db),
    orgUsers: new postgresAuth.OrgUserRepository(db),
    auditLog: new postgresAuth.AuditLogRepository(db),
    apiKeys: new postgresAuth.ApiKeyRepository(db),
    preferences: new postgresAuth.PreferencesRepository(db),
  };
}

function createPostgresRbacRepositories(db: DbClient): RbacRepositoryBundle {
  return {
    roles: new postgresAuth.RoleRepository(db),
    permissions: new postgresAuth.PermissionRepository(db),
    userRoles: new postgresAuth.UserRoleRepository(db),
    teamRoles: new postgresAuth.TeamRoleRepository(db),
    teamMembers: new postgresAuth.TeamMemberRepository(db),
    folders: new postgresAuth.FolderRepository(db),
    dashboardAcl: new postgresAuth.DashboardAclRepository(db),
    quotas: new postgresAuth.QuotaRepository(db),
    teams: new postgresAuth.TeamRepository(db),
  };
}

function buildSqlite(): Persistence {
  const path = dbPath();
  const db = createSqliteClient({ path });
  applySchema(db);
  return {
    backend: 'sqlite',
    db,
    repos: createSqliteRepositories(db),
    authRepos: createSqliteAuthRepositories(db),
    rbacRepos: createSqliteRbacRepositories(db),
  };
}

async function buildPostgres(url: string): Promise<Persistence> {
  const poolSize = Number(process.env['DATABASE_POOL_SIZE'] ?? '10');
  const db = createDbClient({
    url,
    poolSize: Number.isFinite(poolSize) && poolSize > 0 ? poolSize : undefined,
    ssl: process.env['DATABASE_SSL'] === 'true' || process.env['DATABASE_SSL'] === '1',
  });
  await applyPostgresSchema(db);
  return {
    backend: 'postgres',
    db,
    repos: createPostgresRepositories(db),
    authRepos: createPostgresAuthRepositories(db),
    rbacRepos: createPostgresRbacRepositories(db),
  };
}

export interface PersistenceConfig {
  /** Read from `process.env.DATABASE_URL` when undefined. */
  databaseUrl?: string | undefined;
}

export async function createPersistence(
  config: PersistenceConfig = {},
): Promise<Persistence> {
  const dbUrl = config.databaseUrl ?? process.env['DATABASE_URL'];

  if (dbUrl !== undefined && dbUrl !== '' && !isPostgresUrl(dbUrl)) {
    throw new Error(
      `DATABASE_URL is set but does not start with postgres:// or postgresql://. ` +
      `Refusing to silently fall back to SQLite. Unset DATABASE_URL to use ` +
      `SQLite, or fix the connection string. Got: ${dbUrl.slice(0, 16)}...`,
    );
  }

  const persistence = isPostgresUrl(dbUrl) ? await buildPostgres(dbUrl) : buildSqlite();

  // Readiness has to be able to ask whether the database answers. Registered
  // here because this is the one place that knows a database was built at all
  // — the probe route previously hardcoded "No DB configured", which was left
  // over from the in-memory era and made a pod with a dead database report
  // itself ready.
  setDatabaseProbe(async () => {
    await persistence.db.all(sql`SELECT 1`);
  });

  return persistence;
}
