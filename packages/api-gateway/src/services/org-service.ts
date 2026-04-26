/**
 * OrgService — org CRUD + membership management.
 *
 * Implements the contract described in docs/auth-perm-design/04-organizations.md
 * §crud-service.
 *
 * Grafana reference (read for semantics only, nothing copied):
 *   pkg/services/org/orgimpl/org.go          — create/update/delete flow
 *   pkg/services/org/orgimpl/org_user.go     — membership flow
 *   pkg/api/org.go, pkg/api/org_users.go     — HTTP handler layer
 *
 * Side-effects for create:
 *   1. Insert `org` row.
 *   2. Seed RBAC (`basic:*` + fixed roles) for the new org.
 *   3. Insert `org_user` row marking the creator as Admin.
 *   4. Initialize default quotas (users, dashboards, datasources, api_keys,
 *      folders, alert_rules, service_accounts) from env overrides.
 *   5. Audit log `org.created`.
 *
 * Side-effects for delete:
 *   - Cascade via FK (resources with `org_id` FK) OR application-level where
 *     there is no FK (resource tables ALTERed in migration 015).
 *   - Reassign `user.org_id` for any user whose default org was the deleted
 *     one to their first remaining org membership, or to `org_main`.
 *   - Audit log `org.deleted`.
 */

import { sql } from 'drizzle-orm';
import type {
  IOrgRepository,
  IOrgUserRepository,
  IQuotaRepository,
  IUserRepository,
  ListOptions,
  OrgUserWithProfile,
  OrgWithUserCount,
  Page,
  Org,
  OrgPatch,
  OrgRole,
  OrgUser,
} from '@agentic-obs/common';
import { AuditAction, ORG_ROLES } from '@agentic-obs/common';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { seedRbacForOrg } from '@agentic-obs/data-layer';
import type { AuditWriter } from '../auth/audit-writer.js';

const DEFAULT_QUOTA_TARGETS = [
  'users',
  'dashboards',
  'datasources',
  'api_keys',
  'folders',
  'alert_rules',
  'service_accounts',
] as const;

export type QuotaTarget = (typeof DEFAULT_QUOTA_TARGETS)[number];

export class OrgServiceError extends Error {
  constructor(
    public readonly kind:
      | 'validation'
      | 'conflict'
      | 'not_found'
      | 'version_mismatch',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OrgServiceError';
  }
}

export interface CreateOrgInput {
  name: string;
  createdBy: string;
}

export interface UpdateOrgInput extends OrgPatch {
  /** Optimistic-concurrency token. Rejects with 409 when stale. */
  expectedVersion?: number;
}

export interface OrgServiceDeps {
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
  users: IUserRepository;
  quotas?: IQuotaRepository;
  audit: AuditWriter;
  /**
   * Raw sqlite client — needed to seed RBAC into a freshly-created org and
   * to clean up org-scoped resource rows on delete (SQLite ALTER-added org_id
   * columns have no FK cascade — see migration 015's `[openobs-deviation]`
   * note).
   */
  db: SqliteClient;
  /** Default fallback org when a user's last org is deleted. */
  defaultOrgId?: string;
  /** Environment overrides for quota defaults. */
  env?: NodeJS.ProcessEnv;
}

/** Parse `QUOTA_<TARGET>_PER_ORG` from env; fallback -1 (unlimited). */
function resolveQuotaDefault(
  env: NodeJS.ProcessEnv,
  target: QuotaTarget,
): number {
  const key = `QUOTA_${target.toUpperCase()}_PER_ORG`;
  const v = env[key];
  if (!v) return -1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : -1;
}

/** Resource tables that gained `org_id` via migration 015. */
const ORG_SCOPED_TABLES = [
  'dashboards',
  // `dashboard_messages` was dropped by migration 020 — chat history now
  // lives in `chat_messages` (already org-scoped below).
  'investigations',
  'investigation_reports',
  'incidents',
  'feed_items',
  'post_mortems',
  'alert_rules',
  'alert_history',
  'alert_silences',
  'chat_sessions',
  'chat_messages',
  'chat_session_events',
  'approvals',
] as const;

export class OrgService {
  private readonly defaultOrgId: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: OrgServiceDeps) {
    this.defaultOrgId = deps.defaultOrgId ?? 'org_main';
    this.env = deps.env ?? process.env;
  }

  // — Org CRUD ————————————————————————————————————————————————————

  async create(input: CreateOrgInput): Promise<Org> {
    const name = input.name?.trim();
    if (!name) {
      throw new OrgServiceError('validation', 'name is required', 400);
    }
    const existing = await this.deps.orgs.findByName(name);
    if (existing) {
      throw new OrgServiceError(
        'conflict',
        'organization name taken',
        409,
      );
    }

    const creator = await this.deps.users.findById(input.createdBy);
    if (!creator) {
      throw new OrgServiceError('validation', 'creator user not found', 400);
    }

    const org = await this.deps.orgs.create({ name });

    // Seed RBAC (built-in + fixed roles scoped to this org).
    await seedRbacForOrg(this.deps.db, org.id);

    // Add creator as Admin member.
    await this.deps.orgUsers.create({
      orgId: org.id,
      userId: creator.id,
      role: 'Admin',
    });

    // Default quotas from env (-1 = unlimited).
    if (this.deps.quotas) {
      for (const target of DEFAULT_QUOTA_TARGETS) {
        const limitVal = resolveQuotaDefault(this.env, target);
        await this.deps.quotas.upsertOrgQuota(org.id, target, limitVal);
      }
    }

    void this.deps.audit.log({
      action: AuditAction.OrgCreated,
      actorType: 'user',
      actorId: creator.id,
      orgId: org.id,
      targetType: 'org',
      targetId: org.id,
      targetName: org.name,
      outcome: 'success',
    });

    return org;
  }

  async getById(id: string): Promise<Org | null> {
    return this.deps.orgs.findById(id);
  }

  async getByName(name: string): Promise<Org | null> {
    return this.deps.orgs.findByName(name);
  }

  async list(
    opts: ListOptions & { query?: string } = {},
  ): Promise<Page<OrgWithUserCount>> {
    const page = await this.deps.orgs.listWithUserCounts({
      limit: opts.limit,
      offset: opts.offset,
    });
    if (opts.query) {
      const q = opts.query.toLowerCase();
      const filtered = page.items.filter((o) => o.name.toLowerCase().includes(q));
      return { items: filtered, total: filtered.length };
    }
    return page;
  }

  async update(
    id: string,
    patch: UpdateOrgInput,
    actorId: string,
  ): Promise<Org> {
    const before = await this.deps.orgs.findById(id);
    if (!before) {
      throw new OrgServiceError('not_found', 'organization not found', 404);
    }
    if (
      patch.expectedVersion !== undefined &&
      before.version !== patch.expectedVersion
    ) {
      throw new OrgServiceError(
        'version_mismatch',
        'organization was modified concurrently',
        409,
      );
    }
    if (patch.name !== undefined) {
      const name = patch.name?.toString().trim();
      if (!name) {
        throw new OrgServiceError('validation', 'name is required', 400);
      }
      const other = await this.deps.orgs.findByName(name);
      if (other && other.id !== id) {
        throw new OrgServiceError('conflict', 'organization name taken', 409);
      }
    }

    const { expectedVersion: _omit, ...repoPatch } = patch;
    void _omit;
    const updated = await this.deps.orgs.update(id, repoPatch);
    if (!updated) {
      throw new OrgServiceError('not_found', 'organization not found', 404);
    }
    void this.deps.audit.log({
      action: AuditAction.OrgUpdated,
      actorType: 'user',
      actorId,
      orgId: updated.id,
      targetType: 'org',
      targetId: updated.id,
      targetName: updated.name,
      outcome: 'success',
    });
    return updated;
  }

  async delete(id: string, actorId: string): Promise<void> {
    const org = await this.deps.orgs.findById(id);
    if (!org) {
      throw new OrgServiceError('not_found', 'organization not found', 404);
    }
    // Who were the members? We need them to potentially fix up `user.org_id`.
    const { items: members } = await this.deps.orgUsers.listUsersByOrg(id, {
      limit: 10_000,
    });

    // Cascade-delete org-scoped resources that don't have DB-level FKs
    // (migration 015 added `org_id` via ALTER; SQLite can't add a cascading
    // FK in that path — see the deviation note in 015_alter_resources.sql).
    // Table names come from a static allowlist, not user input, so string
    // interpolation is safe.
    for (const table of ORG_SCOPED_TABLES) {
      try {
        this.deps.db.run(sql.raw(`DELETE FROM ${table} WHERE org_id = '${id.replace(/'/g, "''")}'`));
      } catch (_err) {
        // Some tables may not exist on older schemas or in mini integration
        // DBs. Best-effort — swallow and continue; the delete() API contract
        // is "cascades where possible".
      }
    }
    // Reassign user.org_id for any user whose default org was this one —
    // must happen BEFORE deleting the org row because user.org_id is a FK
    // with ON DELETE RESTRICT (see migration 002_user.sql).
    for (const m of members) {
      const user = await this.deps.users.findById(m.userId);
      if (!user) continue;
      if (user.orgId !== id) continue;
      // Remaining memberships EXCLUDING the one we're about to delete —
      // org_user rows for this org are still present at this point.
      const remaining = (await this.deps.orgUsers.listOrgsByUser(user.id)).filter(
        (o) => o.orgId !== id,
      );
      const fallback = remaining[0]?.orgId ?? this.defaultOrgId;
      await this.deps.users.update(user.id, { orgId: fallback });
    }
    // And the actor (if they had it as default).
    const actor = await this.deps.users.findById(actorId);
    if (actor && actor.orgId === id) {
      const remaining = (await this.deps.orgUsers.listOrgsByUser(actor.id)).filter(
        (o) => o.orgId !== id,
      );
      const fallback = remaining[0]?.orgId ?? this.defaultOrgId;
      await this.deps.users.update(actor.id, { orgId: fallback });
    }

    // Auth-perm child rows with FKs to org — must be removed before the
    // org row itself (FKs are declared without ON DELETE CASCADE).
    const sanitized = id.replace(/'/g, "''");
    const cascadeTables = [
      'org_user',
      'role',
      'builtin_role',
      'user_role',
      'team_role',
      'team',
      'quota',
      'dashboard_acl',
      'preferences',
      'folder',
    ];
    for (const t of cascadeTables) {
      try {
        this.deps.db.run(sql.raw(`DELETE FROM ${t} WHERE org_id = '${sanitized}'`));
      } catch (_err) {
        // Tables may not exist in some schemas; best-effort cascade.
      }
    }

    await this.deps.orgs.delete(id);

    void this.deps.audit.log({
      action: AuditAction.OrgDeleted,
      actorType: 'user',
      actorId,
      orgId: id,
      targetType: 'org',
      targetId: id,
      targetName: org.name,
      outcome: 'success',
    });
  }

  // — Membership ————————————————————————————————————————————————————

  async listUsers(
    orgId: string,
    opts: {
      query?: string;
      limit?: number;
      offset?: number;
      /** Defaults to `false` so the Admin → Users tab hides service accounts. */
      isServiceAccount?: boolean;
    } = {},
  ): Promise<Page<OrgUserWithProfile>> {
    return this.deps.orgUsers.listUsersByOrg(orgId, {
      search: opts.query,
      limit: opts.limit,
      offset: opts.offset,
      isServiceAccount: opts.isServiceAccount ?? false,
    });
  }

  /**
   * Add a user to an org by login/email. Mirrors
   * `pkg/api/org_users.go::AddOrgUser` semantics:
   *   - user not found → 400 "user not found"
   *   - already a member → 409 "user is already member of this organization"
   */
  async addUserByLoginOrEmail(
    orgId: string,
    loginOrEmail: string,
    role: OrgRole,
    actorId: string,
  ): Promise<OrgUser> {
    if (!ORG_ROLES.includes(role)) {
      throw new OrgServiceError(
        'validation',
        `role must be one of: ${ORG_ROLES.join(', ')}`,
        400,
      );
    }
    const org = await this.deps.orgs.findById(orgId);
    if (!org) {
      throw new OrgServiceError('not_found', 'organization not found', 404);
    }

    // Resolve user — try login then email.
    let user = await this.deps.users.findByLogin(loginOrEmail);
    if (!user) user = await this.deps.users.findByEmail(loginOrEmail);
    if (!user) {
      throw new OrgServiceError('validation', 'user not found', 400);
    }

    const existing = await this.deps.orgUsers.findMembership(orgId, user.id);
    if (existing) {
      throw new OrgServiceError(
        'conflict',
        'user is already member of this organization',
        409,
      );
    }

    const membership = await this.deps.orgUsers.create({
      orgId,
      userId: user.id,
      role,
    });
    void this.deps.audit.log({
      action: AuditAction.OrgUserAdded,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'user',
      targetId: user.id,
      targetName: user.login,
      outcome: 'success',
      metadata: { role },
    });
    return membership;
  }

  async updateUserRole(
    orgId: string,
    userId: string,
    role: OrgRole,
    actorId: string,
  ): Promise<OrgUser> {
    if (!ORG_ROLES.includes(role)) {
      throw new OrgServiceError(
        'validation',
        `role must be one of: ${ORG_ROLES.join(', ')}`,
        400,
      );
    }
    const updated = await this.deps.orgUsers.updateRole(orgId, userId, role);
    if (!updated) {
      throw new OrgServiceError('not_found', 'membership not found', 404);
    }
    void this.deps.audit.log({
      action: AuditAction.OrgUserRoleChanged,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'user',
      targetId: userId,
      outcome: 'success',
      metadata: { role },
    });
    return updated;
  }

  async removeUser(
    orgId: string,
    userId: string,
    actorId: string,
  ): Promise<void> {
    const existing = await this.deps.orgUsers.findMembership(orgId, userId);
    if (!existing) {
      throw new OrgServiceError('not_found', 'membership not found', 404);
    }
    await this.deps.orgUsers.remove(orgId, userId);

    // If the user's default org is the one we just removed them from,
    // reassign to their first remaining org or the deployment default.
    const user = await this.deps.users.findById(userId);
    if (user && user.orgId === orgId) {
      const remaining = await this.deps.orgUsers.listOrgsByUser(userId);
      const fallback = remaining[0]?.orgId ?? this.defaultOrgId;
      if (fallback !== orgId) {
        await this.deps.users.update(userId, { orgId: fallback });
      }
    }
    void this.deps.audit.log({
      action: AuditAction.OrgUserRemoved,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'user',
      targetId: userId,
      outcome: 'success',
    });
  }
}
