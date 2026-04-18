/**
 * ServiceAccountService — CRUD for the "SA is a user with is_service_account=1"
 * identity per docs/auth-perm-design/06-service-accounts.md.
 *
 * Grafana reference (read for semantics only, nothing copied):
 *   pkg/services/serviceaccounts/manager/service.go — create / delete flow
 *   pkg/api/serviceaccounts.go                      — HTTP handler semantics
 *
 * Side-effects for create:
 *   1. Generate login `sa-<slug>` with collision-handling counter suffix.
 *   2. Insert `user` row (is_service_account=1, is_admin=0).
 *   3. Insert `org_user` row with the caller-supplied role.
 *   4. Enforce quota.target='service_accounts' per org before step 2.
 *   5. Audit `serviceaccount.created`.
 *
 * Side-effects for delete:
 *   1. Hard-delete all `api_key` rows with `service_account_id=id`.
 *   2. Rely on FK CASCADE to clean up `user_role`, `team_member`, `org_user`.
 *   3. Delete `user` row.
 *   4. Audit `serviceaccount.deleted`.
 */

import {
  AuditAction,
  ORG_ROLES,
  type IApiKeyRepository,
  type IOrgUserRepository,
  type IQuotaRepository,
  type ITeamMemberRepository,
  type IUserRepository,
  type IUserRoleRepository,
  type OrgRole,
  type User,
} from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';

export class ServiceAccountServiceError extends Error {
  constructor(
    public readonly kind:
      | 'validation'
      | 'not_found'
      | 'conflict'
      | 'quota_exceeded',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ServiceAccountServiceError';
  }
}

export interface ServiceAccount {
  id: string;
  orgId: string;
  login: string;
  name: string;
  role: OrgRole;
  isDisabled: boolean;
  created: string;
  updated: string;
  lastSeenAt: string | null;
}

export interface CreateServiceAccountInput {
  name: string;
  role: OrgRole;
  isDisabled?: boolean;
}

export interface UpdateServiceAccountInput {
  name?: string;
  role?: OrgRole;
  isDisabled?: boolean;
}

export interface ListServiceAccountsOpts {
  query?: string;
  limit?: number;
  offset?: number;
  disabled?: boolean;
}

export interface ServiceAccountServiceDeps {
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  apiKeys: IApiKeyRepository;
  userRoles?: IUserRoleRepository;
  teamMembers?: ITeamMemberRepository;
  quotas?: IQuotaRepository;
  audit: AuditWriter;
  /** For quota defaults. */
  env?: NodeJS.ProcessEnv;
}

export interface IServiceAccountService {
  create(
    orgId: string,
    actorId: string,
    input: CreateServiceAccountInput,
  ): Promise<ServiceAccount>;
  getById(orgId: string, id: string): Promise<ServiceAccount | null>;
  list(
    orgId: string,
    opts?: ListServiceAccountsOpts,
  ): Promise<{ items: ServiceAccount[]; total: number }>;
  update(
    orgId: string,
    id: string,
    actorId: string,
    patch: UpdateServiceAccountInput,
  ): Promise<ServiceAccount>;
  delete(orgId: string, id: string, actorId: string): Promise<void>;
}

// -- helpers ---------------------------------------------------------------

/**
 * Slugify a name into a login-safe suffix:
 *   "Grafana Prom Scraper!" → "grafana-prom-scraper"
 * Only [a-z0-9-] permitted, collapse runs, trim edges.
 */
export function slugify(input: string): string {
  const lower = input.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, '-');
  return replaced.replace(/^-+|-+$/g, '') || 'sa';
}

function parseQuotaLimit(env: NodeJS.ProcessEnv): number {
  const v = env['QUOTA_SERVICE_ACCOUNTS_PER_ORG'];
  if (!v) return -1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : -1;
}

function userToSA(user: User, role: OrgRole): ServiceAccount {
  return {
    id: user.id,
    orgId: user.orgId,
    login: user.login,
    name: user.name,
    role,
    isDisabled: user.isDisabled,
    created: user.created,
    updated: user.updated,
    lastSeenAt: user.lastSeenAt,
  };
}

// -- service ---------------------------------------------------------------

export class ServiceAccountService implements IServiceAccountService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: ServiceAccountServiceDeps) {
    this.env = deps.env ?? process.env;
  }

  // -- create --------------------------------------------------------------

  async create(
    orgId: string,
    actorId: string,
    input: CreateServiceAccountInput,
  ): Promise<ServiceAccount> {
    const name = input.name?.trim();
    if (!name) {
      throw new ServiceAccountServiceError(
        'validation',
        'name is required',
        400,
      );
    }
    if (!ORG_ROLES.includes(input.role)) {
      throw new ServiceAccountServiceError(
        'validation',
        `role must be one of: ${ORG_ROLES.join(', ')}`,
        400,
      );
    }

    // Quota enforcement — count rows BEFORE insert to match Grafana's check
    // order in pkg/services/serviceaccounts/manager/service.go.
    const envLimit = parseQuotaLimit(this.env);
    let limit = envLimit;
    if (this.deps.quotas) {
      const row = await this.deps.quotas.findOrgQuota(
        orgId,
        'service_accounts',
      );
      if (row && Number.isFinite(row.limitVal)) limit = row.limitVal;
    }
    if (limit >= 0) {
      const current = await this.deps.users.countServiceAccounts(orgId);
      if (current >= limit) {
        throw new ServiceAccountServiceError(
          'quota_exceeded',
          'Quota exceeded',
          403,
        );
      }
    }

    // Generate unique login sa-<slug>[-N]
    const baseLogin = `sa-${slugify(name)}`;
    let login = baseLogin;
    let counter = 1;
    // ~12 collision retries is plenty; beyond that, surface a conflict.
    for (let i = 0; i < 12; i += 1) {
      const existing = await this.deps.users.findByLogin(login);
      if (!existing) break;
      counter += 1;
      login = `${baseLogin}-${counter}`;
    }
    const clash = await this.deps.users.findByLogin(login);
    if (clash) {
      throw new ServiceAccountServiceError(
        'conflict',
        'could not generate unique login',
        409,
      );
    }

    // Synthetic email ensures unique (email, login) constraints — SAs don't
    // receive mail. Grafana uses "<login>@serviceaccount"; we follow the same
    // shape since email is a required non-null column in our user table.
    const email = `${login}@serviceaccount.local`;

    const user = await this.deps.users.create({
      email,
      name,
      login,
      orgId,
      isAdmin: false,
      isDisabled: input.isDisabled ?? false,
      isServiceAccount: true,
      emailVerified: false,
    });

    await this.deps.orgUsers.create({
      orgId,
      userId: user.id,
      role: input.role,
    });

    const sa = userToSA(user, input.role);
    void this.deps.audit.log({
      action: AuditAction.ServiceAccountCreated,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'service_account',
      targetId: sa.id,
      targetName: sa.login,
      outcome: 'success',
      metadata: { role: input.role },
    });
    return sa;
  }

  // -- read ----------------------------------------------------------------

  async getById(orgId: string, id: string): Promise<ServiceAccount | null> {
    const user = await this.deps.users.findById(id);
    if (!user || !user.isServiceAccount || user.orgId !== orgId) return null;
    const membership = await this.deps.orgUsers.findMembership(orgId, id);
    return userToSA(user, membership?.role ?? 'None');
  }

  async list(
    orgId: string,
    opts: ListServiceAccountsOpts = {},
  ): Promise<{ items: ServiceAccount[]; total: number }> {
    const page = await this.deps.users.list({
      orgId,
      isServiceAccount: true,
      ...(opts.disabled !== undefined ? { isDisabled: opts.disabled } : {}),
      search: opts.query,
      limit: opts.limit,
      offset: opts.offset,
    });
    // Attach org role per SA. N+1 is fine — SA counts are small.
    const items: ServiceAccount[] = [];
    for (const user of page.items) {
      const membership = await this.deps.orgUsers.findMembership(
        orgId,
        user.id,
      );
      items.push(userToSA(user, membership?.role ?? 'None'));
    }
    return { items, total: page.total };
  }

  // -- update --------------------------------------------------------------

  async update(
    orgId: string,
    id: string,
    actorId: string,
    patch: UpdateServiceAccountInput,
  ): Promise<ServiceAccount> {
    const user = await this.deps.users.findById(id);
    if (!user || !user.isServiceAccount || user.orgId !== orgId) {
      throw new ServiceAccountServiceError(
        'not_found',
        'service account not found',
        404,
      );
    }
    if (patch.role !== undefined && !ORG_ROLES.includes(patch.role)) {
      throw new ServiceAccountServiceError(
        'validation',
        `role must be one of: ${ORG_ROLES.join(', ')}`,
        400,
      );
    }

    // User-row changes.
    const userPatch: { name?: string; isDisabled?: boolean } = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) {
        throw new ServiceAccountServiceError(
          'validation',
          'name must be non-empty',
          400,
        );
      }
      userPatch.name = trimmed;
    }
    if (patch.isDisabled !== undefined) userPatch.isDisabled = patch.isDisabled;
    if (Object.keys(userPatch).length > 0) {
      await this.deps.users.update(id, userPatch);
    }

    // Role change goes through org_user.
    if (patch.role !== undefined) {
      await this.deps.orgUsers.updateRole(orgId, id, patch.role);
    }

    const updated = await this.deps.users.findById(id);
    if (!updated) {
      throw new ServiceAccountServiceError(
        'not_found',
        'service account disappeared mid-update',
        404,
      );
    }
    const membership = await this.deps.orgUsers.findMembership(orgId, id);
    const sa = userToSA(updated, membership?.role ?? 'None');

    void this.deps.audit.log({
      action: AuditAction.ServiceAccountUpdated,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'service_account',
      targetId: sa.id,
      targetName: sa.login,
      outcome: 'success',
      metadata: { ...patch },
    });
    return sa;
  }

  // -- delete --------------------------------------------------------------

  async delete(orgId: string, id: string, actorId: string): Promise<void> {
    const user = await this.deps.users.findById(id);
    if (!user || !user.isServiceAccount || user.orgId !== orgId) {
      throw new ServiceAccountServiceError(
        'not_found',
        'service account not found',
        404,
      );
    }

    // Hard-delete tokens first — FK from api_key.service_account_id has
    // ON DELETE CASCADE declared in 008_api_key.sql, but we do this
    // explicitly so the audit trail doesn't depend on DB specifics.
    const tokens = await this.deps.apiKeys.list({
      orgId,
      serviceAccountId: id,
      includeRevoked: true,
      includeExpired: true,
    });
    for (const k of tokens.items) {
      await this.deps.apiKeys.delete(k.id);
    }

    // Remaining FK cascades (user_role / team_member / org_user) are declared
    // in their respective migrations. We still explicit-delete team_member
    // and user_role when repos are provided, to keep behavior consistent
    // across SQLite pragma settings.
    if (this.deps.teamMembers) {
      await this.deps.teamMembers.removeAllByUser(id);
    }
    if (this.deps.userRoles) {
      const rows = await this.deps.userRoles.listByUser(id, orgId);
      for (const r of rows) await this.deps.userRoles.delete(r.id);
    }
    await this.deps.orgUsers.remove(orgId, id);

    await this.deps.users.delete(id);

    void this.deps.audit.log({
      action: AuditAction.ServiceAccountDeleted,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'service_account',
      targetId: user.id,
      targetName: user.login,
      outcome: 'success',
    });
  }
}
