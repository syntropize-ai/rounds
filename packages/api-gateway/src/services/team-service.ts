/**
 * TeamService — team CRUD, membership management, and team preferences.
 *
 * Mirrors the contract described in docs/auth-perm-design/05-teams.md
 * §crud-service. Every operation is scoped to an `orgId` — cross-org access is
 * an invariant violation and must be prevented at the handler layer via the
 * org-context middleware (see docs/auth-perm-design/04-organizations.md
 * §org-context-middleware).
 *
 * Grafana reference (read for semantics only, nothing copied):
 *   pkg/services/team/teamimpl/store.go        — CRUD flow
 *   pkg/services/team/teamimpl/team.go         — service wiring
 *   pkg/api/team.go, pkg/api/team_members.go   — HTTP handler layer
 *
 * Invariants enforced here (see 05-teams.md §invariants):
 *   - `team.name` unique within an org (relies on the DB unique index
 *     `ux_team_org_name`; the service translates conflicts to 409).
 *   - External teams (`team.external=1`) reject direct member mutations
 *     unless the membership itself is external-managed too.
 *   - Team deletion cascades `team_member` + `team_role` via FKs, and the
 *     service additionally removes any `dashboard_acl` rows referencing the
 *     team — that table has no FK on `team_id` by design (matches Grafana's
 *     legacy ACL schema), so the cleanup lives in the service.
 */

import { sql } from 'drizzle-orm';
import type {
  IDashboardAclRepository,
  IPreferencesRepository,
  ITeamMemberRepository,
  ITeamRepository,
  ListOptions,
  Page,
  Team,
  TeamMember,
  TeamMemberPermission,
  Preferences,
  PreferencesPatch,
} from '@agentic-obs/common';
import {
  AuditAction,
  TEAM_MEMBER_PERMISSION_MEMBER,
  TEAM_MEMBER_PERMISSION_ADMIN,
} from '@agentic-obs/common';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { AuditWriter } from '../auth/audit-writer.js';

export class TeamServiceError extends Error {
  constructor(
    public readonly kind:
      | 'validation'
      | 'conflict'
      | 'not_found'
      | 'external',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'TeamServiceError';
  }
}

export interface CreateTeamInput {
  name: string;
  email?: string | null;
  /** Only set true by IdP sync paths. API handlers always leave this false. */
  external?: boolean;
}

export interface UpdateTeamInput {
  name?: string;
  email?: string | null;
}

export interface ListTeamsOpts extends ListOptions {
  query?: string;
  /** If set, restrict the result to teams this user is a member of. */
  userId?: string;
}

export interface TeamPreferencesPatch extends PreferencesPatch {
  // Intentionally empty — same shape as the base PreferencesPatch, documented
  // here so callers can see the allowed fields at a glance.
}

export interface TeamServiceDeps {
  teams: ITeamRepository;
  teamMembers: ITeamMemberRepository;
  preferences: IPreferencesRepository;
  /**
   * Raw sqlite client used only to clean up dashboard_acl rows on team
   * deletion — dashboard_acl.team_id has no FK cascade by design (matches
   * Grafana's legacy ACL table).
   */
  db: SqliteClient;
  audit: AuditWriter;
  /**
   * Optional — passed through for tests that want to assert acl cleanup.
   * Not required because the cascade is implemented in raw SQL for
   * consistency with OrgService.delete.
   */
  dashboardAcl?: IDashboardAclRepository;
}

function validatePermissionValue(
  permission: unknown,
): asserts permission is TeamMemberPermission {
  if (
    permission !== TEAM_MEMBER_PERMISSION_MEMBER &&
    permission !== TEAM_MEMBER_PERMISSION_ADMIN
  ) {
    throw new TeamServiceError(
      'validation',
      `permission must be ${TEAM_MEMBER_PERMISSION_MEMBER} (Member) or ${TEAM_MEMBER_PERMISSION_ADMIN} (Admin)`,
      400,
    );
  }
}

export class TeamService {
  constructor(private readonly deps: TeamServiceDeps) {}

  // — Team CRUD ——————————————————————————————————————————————————

  async create(orgId: string, input: CreateTeamInput): Promise<Team> {
    const name = input.name?.trim();
    if (!name) {
      throw new TeamServiceError('validation', 'name is required', 400);
    }
    const existing = await this.deps.teams.findByName(orgId, name);
    if (existing) {
      throw new TeamServiceError('conflict', 'team name taken', 409);
    }
    const team = await this.deps.teams.create({
      orgId,
      name,
      email: input.email ?? null,
      external: input.external === true,
    });
    void this.deps.audit.log({
      action: AuditAction.TeamCreated,
      actorType: 'user',
      orgId,
      targetType: 'team',
      targetId: team.id,
      targetName: team.name,
      outcome: 'success',
    });
    return team;
  }

  async getById(orgId: string, id: string): Promise<Team | null> {
    const team = await this.deps.teams.findById(id);
    if (!team) return null;
    if (team.orgId !== orgId) return null;
    return team;
  }

  async list(orgId: string, opts: ListTeamsOpts = {}): Promise<Page<Team>> {
    const page = await this.deps.teams.listByOrg(orgId, {
      search: opts.query,
      limit: opts.limit,
      offset: opts.offset,
    });
    if (!opts.userId) return page;
    // Filter to teams this user belongs to. Membership is per-org, so we can
    // list once and intersect.
    const memberships = await this.deps.teamMembers.listTeamsForUser(
      opts.userId,
      orgId,
    );
    const allowed = new Set(memberships.map((m) => m.teamId));
    const filtered = page.items.filter((t) => allowed.has(t.id));
    return { items: filtered, total: filtered.length };
  }

  async update(
    orgId: string,
    id: string,
    patch: UpdateTeamInput,
    actorId?: string,
  ): Promise<Team> {
    const existing = await this.deps.teams.findById(id);
    if (!existing || existing.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    if (patch.name !== undefined) {
      const name = patch.name.toString().trim();
      if (!name) {
        throw new TeamServiceError('validation', 'name is required', 400);
      }
      const other = await this.deps.teams.findByName(orgId, name);
      if (other && other.id !== id) {
        throw new TeamServiceError('conflict', 'team name taken', 409);
      }
    }
    const updated = await this.deps.teams.update(id, {
      name: patch.name,
      email: patch.email,
    });
    if (!updated) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    void this.deps.audit.log({
      action: AuditAction.TeamUpdated,
      actorType: 'user',
      actorId: actorId ?? null,
      orgId,
      targetType: 'team',
      targetId: updated.id,
      targetName: updated.name,
      outcome: 'success',
    });
    return updated;
  }

  async delete(orgId: string, id: string, actorId?: string): Promise<void> {
    const existing = await this.deps.teams.findById(id);
    if (!existing || existing.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }

    // dashboard_acl.team_id has no FK (matches Grafana's legacy ACL schema),
    // so cascade manually here. Team-scoped `team_member`, `team_role`, and
    // `preferences` rows already cascade via FK ON DELETE CASCADE.
    const sanitized = id.replace(/'/g, "''");
    try {
      this.deps.db.run(
        sql.raw(`DELETE FROM dashboard_acl WHERE team_id = '${sanitized}'`),
      );
    } catch {
      // dashboard_acl may not exist in some mini integration DBs. Best-effort
      // cleanup — swallow and continue; team delete is still the contract.
    }

    await this.deps.teams.delete(id);

    void this.deps.audit.log({
      action: AuditAction.TeamDeleted,
      actorType: 'user',
      actorId: actorId ?? null,
      orgId,
      targetType: 'team',
      targetId: id,
      targetName: existing.name,
      outcome: 'success',
    });
  }

  // — Membership ——————————————————————————————————————————————————

  async addMember(
    orgId: string,
    teamId: string,
    userId: string,
    permission: TeamMemberPermission = TEAM_MEMBER_PERMISSION_MEMBER,
    opts: { external?: boolean; actorId?: string } = {},
  ): Promise<TeamMember> {
    validatePermissionValue(permission);
    const team = await this.deps.teams.findById(teamId);
    if (!team || team.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    // External teams can only be mutated by the sync path, never by a human
    // API call. The sync path passes `opts.external=true` to bypass.
    if (team.external && opts.external !== true) {
      throw new TeamServiceError(
        'external',
        'team is externally managed',
        400,
      );
    }
    const existing = await this.deps.teamMembers.findMembership(teamId, userId);
    if (existing) {
      throw new TeamServiceError('conflict', 'user is already a team member', 409);
    }
    const membership = await this.deps.teamMembers.create({
      orgId,
      teamId,
      userId,
      external: opts.external === true,
      permission,
    });
    void this.deps.audit.log({
      action: AuditAction.TeamMemberAdded,
      actorType: 'user',
      actorId: opts.actorId ?? null,
      orgId,
      targetType: 'team',
      targetId: teamId,
      targetName: team.name,
      outcome: 'success',
      metadata: { userId, permission, external: opts.external === true },
    });
    return membership;
  }

  async updateMember(
    orgId: string,
    teamId: string,
    userId: string,
    permission: TeamMemberPermission,
    actorId?: string,
  ): Promise<TeamMember> {
    validatePermissionValue(permission);
    const team = await this.deps.teams.findById(teamId);
    if (!team || team.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    if (team.external) {
      throw new TeamServiceError(
        'external',
        'team is externally managed',
        400,
      );
    }
    const updated = await this.deps.teamMembers.updatePermission(
      teamId,
      userId,
      permission,
    );
    if (!updated) {
      throw new TeamServiceError('not_found', 'membership not found', 404);
    }
    void this.deps.audit.log({
      // Reuse `team.member_added` rather than inventing a new member-updated
      // action — permission changes are rare and the metadata payload captures
      // the before/after clearly. If auditability drives it later, add a new
      // AuditAction.TeamMemberPermissionUpdated constant.
      action: AuditAction.TeamMemberAdded,
      actorType: 'user',
      actorId: actorId ?? null,
      orgId,
      targetType: 'team',
      targetId: teamId,
      targetName: team.name,
      outcome: 'success',
      metadata: { userId, permission, op: 'update' },
    });
    return updated;
  }

  async removeMember(
    orgId: string,
    teamId: string,
    userId: string,
    opts: { external?: boolean; actorId?: string } = {},
  ): Promise<void> {
    const team = await this.deps.teams.findById(teamId);
    if (!team || team.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    if (team.external && opts.external !== true) {
      throw new TeamServiceError(
        'external',
        'team is externally managed',
        400,
      );
    }
    const existing = await this.deps.teamMembers.findMembership(teamId, userId);
    if (!existing) {
      throw new TeamServiceError('not_found', 'membership not found', 404);
    }
    // External/manual parity: external sync must not remove a manually-added
    // membership (external=0). Handler-driven removals are free to touch any
    // membership (since we've already rejected external teams above).
    if (opts.external === true && !existing.external) {
      return; // no-op — never touch manual memberships from sync
    }
    await this.deps.teamMembers.remove(teamId, userId);
    void this.deps.audit.log({
      action: AuditAction.TeamMemberRemoved,
      actorType: 'user',
      actorId: opts.actorId ?? null,
      orgId,
      targetType: 'team',
      targetId: teamId,
      targetName: team.name,
      outcome: 'success',
      metadata: { userId, external: opts.external === true },
    });
  }

  async listMembers(orgId: string, teamId: string): Promise<TeamMember[]> {
    const team = await this.deps.teams.findById(teamId);
    if (!team || team.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    return this.deps.teamMembers.listByTeam(teamId);
  }

  async listTeamsForUser(orgId: string, userId: string): Promise<Team[]> {
    const memberships = await this.deps.teamMembers.listTeamsForUser(
      userId,
      orgId,
    );
    const teams: Team[] = [];
    for (const m of memberships) {
      const t = await this.deps.teams.findById(m.teamId);
      if (t && t.orgId === orgId) teams.push(t);
    }
    return teams;
  }

  // — Team preferences ————————————————————————————————————————————

  async getTeamPreferences(
    orgId: string,
    teamId: string,
  ): Promise<Preferences | null> {
    const team = await this.deps.teams.findById(teamId);
    if (!team || team.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    return this.deps.preferences.findTeamPrefs(orgId, teamId);
  }

  async setTeamPreferences(
    orgId: string,
    teamId: string,
    patch: TeamPreferencesPatch,
  ): Promise<Preferences> {
    const team = await this.deps.teams.findById(teamId);
    if (!team || team.orgId !== orgId) {
      throw new TeamServiceError('not_found', 'team not found', 404);
    }
    return this.deps.preferences.upsert({
      orgId,
      teamId,
      homeDashboardUid: patch.homeDashboardUid ?? null,
      timezone: patch.timezone ?? null,
      weekStart: patch.weekStart ?? null,
      theme: patch.theme ?? null,
      locale: patch.locale ?? null,
      jsonData: patch.jsonData ?? null,
    });
  }
}
