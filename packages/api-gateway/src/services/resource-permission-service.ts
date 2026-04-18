/**
 * ResourcePermissionService — generic (principal × level × resource) grants
 * backed by the managed-role pattern in §07.
 *
 * For each (resource, uid) and principal, we ensure a single "managed role"
 * per principal (ONE role row per user/team/built-in — not one per resource).
 * Grants are encoded as `permission` rows on that role with the action strings
 * produced by `actionsForLevel()` and the scope `<resource>:uid:<uid>`.
 *
 * The managed role is assigned to the principal exactly once (via user_role,
 * team_role, or builtin_role). Subsequent grants on other resources append
 * permission rows to the same role, so the principal keeps a stable role id
 * the whole time.
 *
 * Grafana reference (read for semantics only):
 *   pkg/services/accesscontrol/resourcepermissions/service.go
 *   pkg/services/accesscontrol/resourcepermissions/store.go
 */

import type {
  IRoleRepository,
  IPermissionRepository,
  IUserRoleRepository,
  ITeamRoleRepository,
  IFolderRepository,
  IUserRepository,
  ITeamRepository,
  Permission as PermissionRow,
  Role,
  ResourceKind,
  ResourcePermissionEntry,
  ResourcePermissionPrincipal,
  ResourcePermissionSetItem,
  BuiltInRoleName,
} from '@agentic-obs/common';
import {
  PermissionLevel,
  actionsForLevel,
  levelForActions,
  managedRoleNameFor,
  managedRoleUidFor,
} from '@agentic-obs/common';

export class ResourcePermissionServiceError extends Error {
  constructor(
    public readonly kind: 'validation' | 'not_found',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ResourcePermissionServiceError';
  }
}

export interface ResourcePermissionServiceDeps {
  roles: IRoleRepository;
  permissions: IPermissionRepository;
  userRoles: IUserRoleRepository;
  teamRoles: ITeamRoleRepository;
  folders: IFolderRepository;
  users?: IUserRepository;
  teams?: ITeamRepository;
}

interface PrincipalBucket {
  principal: ResourcePermissionPrincipal;
  actions: Set<string>;
  roleName: string;
  // Set when the grant is inherited from an ancestor folder.
  inheritedFrom?: { type: 'folder'; uid: string; title: string };
}

/**
 * Resolve a set of `ResourcePermissionSetItem`s into principal + level and
 * validate. Duplicates collapse (last write wins, matching Grafana).
 */
function normalizeSetItems(
  items: readonly ResourcePermissionSetItem[],
): Array<{ principal: ResourcePermissionPrincipal; level: PermissionLevel | null }> {
  const map = new Map<
    string,
    { principal: ResourcePermissionPrincipal; level: PermissionLevel | null }
  >();
  for (const it of items) {
    const set =
      (it.userId ? 1 : 0) + (it.teamId ? 1 : 0) + (it.role ? 1 : 0);
    if (set !== 1) {
      throw new ResourcePermissionServiceError(
        'validation',
        `exactly one of userId/teamId/role must be set (got ${set})`,
        400,
      );
    }
    let principal: ResourcePermissionPrincipal;
    if (it.userId) principal = { kind: 'user', userId: it.userId };
    else if (it.teamId) principal = { kind: 'team', teamId: it.teamId };
    else principal = { kind: 'role', role: it.role! };

    const key = principalKey(principal);
    map.set(key, { principal, level: it.permission });
  }
  return [...map.values()];
}

function principalKey(p: ResourcePermissionPrincipal): string {
  switch (p.kind) {
    case 'user':
      return `u:${p.userId}`;
    case 'team':
      return `t:${p.teamId}`;
    case 'role':
      return `r:${p.role}`;
  }
}

export class ResourcePermissionService {
  constructor(private readonly deps: ResourcePermissionServiceDeps) {}

  /**
   * List permissions on a resource, walking ancestor folders for cascade when
   * the resource type supports it (dashboards + alert.rules inherit from
   * folders; folders inherit from ancestor folders; datasources are flat).
   */
  async list(
    orgId: string,
    resource: ResourceKind,
    uid: string,
    /**
     * Optional hint — the dashboard's folder_uid, used for cascade. When the
     * caller already has the folder UID (e.g. read from the dashboards table)
     * they can pass it here to avoid a round-trip. Ignored for resources that
     * don't cascade.
     */
    ctx: { dashboardFolderUid?: string | null } = {},
  ): Promise<ResourcePermissionEntry[]> {
    const buckets = new Map<string, PrincipalBucket>();

    // 1. Direct permissions on the target resource.
    const directScope = `${resource}:uid:${uid}`;
    await this.collectInto(buckets, orgId, directScope, undefined);

    // 2. Cascade from ancestor folders.
    if (resource === 'folders') {
      const ancestors = await this.deps.folders.listAncestors(orgId, uid);
      for (const f of ancestors) {
        await this.collectInto(buckets, orgId, `folders:uid:${f.uid}`, {
          type: 'folder',
          uid: f.uid,
          title: f.title,
        });
      }
    } else if (resource === 'dashboards' || resource === 'alert.rules') {
      // For dashboards and alert rules the folder UID is read from the
      // respective table by the caller (routes populate `ctx`). If not
      // supplied, we skip cascade — correct but may under-report.
      const folderUid = ctx.dashboardFolderUid ?? null;
      if (folderUid) {
        // Direct folder permission.
        const folder = await this.deps.folders.findByUid(orgId, folderUid);
        if (folder) {
          await this.collectInto(
            buckets,
            orgId,
            `folders:uid:${folderUid}`,
            { type: 'folder', uid: folder.uid, title: folder.title },
          );
          const ancestors = await this.deps.folders.listAncestors(
            orgId,
            folderUid,
          );
          for (const f of ancestors) {
            await this.collectInto(buckets, orgId, `folders:uid:${f.uid}`, {
              type: 'folder',
              uid: f.uid,
              title: f.title,
            });
          }
        }
      }
    }

    // 3. Denormalize buckets into entries.
    const out: ResourcePermissionEntry[] = [];
    for (const b of buckets.values()) {
      const actions = [...b.actions];
      const level = levelForActions(resource, actions);
      const entry: ResourcePermissionEntry = {
        id: b.roleName,
        roleName: b.roleName,
        isManaged: b.roleName.startsWith('managed:'),
        isInherited: !!b.inheritedFrom,
        inheritedFrom: b.inheritedFrom,
        permission: level,
        actions,
      };
      // Attach principal details.
      if (b.principal.kind === 'user') {
        entry.userId = b.principal.userId;
        if (this.deps.users) {
          const u = await this.deps.users.findById(b.principal.userId);
          if (u) {
            entry.userLogin = u.login;
            entry.userEmail = u.email;
          }
        }
      } else if (b.principal.kind === 'team') {
        entry.teamId = b.principal.teamId;
        if (this.deps.teams) {
          const t = await this.deps.teams.findById(b.principal.teamId);
          if (t) entry.teamName = t.name;
        }
      } else {
        entry.builtInRole = b.principal.role;
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Bulk set permissions: add/update for each item, remove when `permission=null`.
   * Items for principals not referenced remain untouched.
   */
  async setBulk(
    orgId: string,
    resource: ResourceKind,
    uid: string,
    items: readonly ResourcePermissionSetItem[],
  ): Promise<void> {
    const normalized = normalizeSetItems(items);
    const scope = `${resource}:uid:${uid}`;

    for (const { principal, level } of normalized) {
      if (level === null) {
        // Remove permissions at this scope for the principal's managed role.
        await this.removeGrant(orgId, principal, scope);
        continue;
      }
      const role = await this.ensureManagedRole(orgId, principal);
      await this.syncActionsForRole(
        role.id,
        scope,
        actionsForLevel(resource, level),
      );
      await this.ensureAssignment(orgId, principal, role.id);
    }
  }

  /** Convenience: set level for one user. */
  async setUserPermission(
    orgId: string,
    resource: ResourceKind,
    uid: string,
    userId: string,
    level: PermissionLevel | null,
  ): Promise<void> {
    await this.setBulk(orgId, resource, uid, [{ userId, permission: level }]);
  }

  async setTeamPermission(
    orgId: string,
    resource: ResourceKind,
    uid: string,
    teamId: string,
    level: PermissionLevel | null,
  ): Promise<void> {
    await this.setBulk(orgId, resource, uid, [{ teamId, permission: level }]);
  }

  async setBuiltInRolePermission(
    orgId: string,
    resource: ResourceKind,
    uid: string,
    role: BuiltInRoleName,
    level: PermissionLevel | null,
  ): Promise<void> {
    await this.setBulk(orgId, resource, uid, [{ role, permission: level }]);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async collectInto(
    buckets: Map<string, PrincipalBucket>,
    orgId: string,
    scope: string,
    inheritedFrom:
      | { type: 'folder'; uid: string; title: string }
      | undefined,
  ): Promise<void> {
    // Find all permission rows at this scope across managed roles in the org.
    // We pull every permission with scope === scope and then look up the role
    // to decide whether it's a managed role (and which principal it maps to).
    const rows = await this.findPermissionsAtScope(scope);
    if (rows.length === 0) return;

    const roleIds = [...new Set(rows.map((r) => r.roleId))];
    // Fetch each role once; we match by org_id to avoid leaking grants from
    // other orgs through a shared managed role name (impossible by schema but
    // we defend anyway).
    const roles = await Promise.all(
      roleIds.map((id) => this.deps.roles.findById(id)),
    );
    const roleById = new Map<string, Role>();
    for (const r of roles) {
      if (r && (r.orgId === orgId || r.orgId === '')) roleById.set(r.id, r);
    }

    // Also look up principal assignments so we only include roles that are
    // assigned to some principal (or are managed-role shaped).
    const userRoleLookup = new Map<string, string>(); // roleId -> userId
    const teamRoleLookup = new Map<string, string>(); // roleId -> teamId
    for (const rid of roleIds) {
      const urs = await this.deps.userRoles.listByRole(rid);
      for (const ur of urs) userRoleLookup.set(rid, ur.userId);
      const trs = await this.deps.teamRoles.listByRole(rid);
      for (const tr of trs) teamRoleLookup.set(rid, tr.teamId);
    }
    // Built-in role bindings require a scan via roles' listBuiltinRoles.
    const builtins = await this.deps.roles.listBuiltinRoles(orgId);
    const builtinById = new Map<string, string>(); // roleId -> builtIn role name
    for (const b of builtins) builtinById.set(b.roleId, b.role);

    for (const row of rows) {
      const role = roleById.get(row.roleId);
      if (!role) continue;

      const principal = this.principalFor(role, {
        userId: userRoleLookup.get(row.roleId),
        teamId: teamRoleLookup.get(row.roleId),
        builtInRole: builtinById.get(row.roleId),
      });
      if (!principal) continue;

      const key = principalKey(principal);
      let b = buckets.get(key);
      if (!b) {
        b = {
          principal,
          actions: new Set<string>(),
          roleName: role.name,
          inheritedFrom,
        };
        buckets.set(key, b);
      } else if (!b.inheritedFrom && inheritedFrom) {
        // Only keep the inheritedFrom marker if we had no direct grant yet.
      } else if (b.inheritedFrom && !inheritedFrom) {
        // Direct grant seen after inherited — clear inheritedFrom so the
        // entry shows as direct.
        b.inheritedFrom = undefined;
      }
      b.actions.add(row.action);
    }
  }

  private principalFor(
    role: Role,
    hints: {
      userId?: string;
      teamId?: string;
      builtInRole?: string;
    },
  ): ResourcePermissionPrincipal | null {
    // Managed role names decode the principal directly.
    const m = /^managed:(users|teams|builtins):([^:]+):permissions$/.exec(role.name);
    if (m) {
      const kind = m[1];
      const id = m[2]!;
      if (kind === 'users') return { kind: 'user', userId: id };
      if (kind === 'teams') return { kind: 'team', teamId: id };
      if (kind === 'builtins') {
        if (id === 'Admin' || id === 'Editor' || id === 'Viewer') {
          return { kind: 'role', role: id };
        }
      }
    }
    // Fallback to assignment hints (non-managed roles used for cascade).
    if (hints.userId) return { kind: 'user', userId: hints.userId };
    if (hints.teamId) return { kind: 'team', teamId: hints.teamId };
    if (
      hints.builtInRole === 'Admin' ||
      hints.builtInRole === 'Editor' ||
      hints.builtInRole === 'Viewer'
    ) {
      return { kind: 'role', role: hints.builtInRole };
    }
    return null;
  }

  private async findPermissionsAtScope(scope: string): Promise<PermissionRow[]> {
    // The interface doesn't expose listByScope directly; we use listByAction
    // across common actions. Cheaper path: iterate the action catalog for
    // every resource kind — small constant. Alternatively, a repo method
    // could be added but that'd be a cross-cutting change.
    // For the managed-role case, actions live in the catalog — we look up by
    // action and filter to this scope.
    // To avoid a huge query, we scan all actions for the four resource kinds.
    const kinds: ResourceKind[] = ['folders', 'dashboards', 'datasources', 'alert.rules'];
    const seenActions = new Set<string>();
    for (const k of kinds) {
      for (const a of [
        ...actionsForLevel(k, PermissionLevel.View),
        ...actionsForLevel(k, PermissionLevel.Edit),
        ...actionsForLevel(k, PermissionLevel.Admin),
      ]) {
        seenActions.add(a);
      }
    }
    const out: PermissionRow[] = [];
    for (const action of seenActions) {
      const rows = await this.deps.permissions.listByAction(action);
      for (const r of rows) if (r.scope === scope) out.push(r);
    }
    return out;
  }

  private async ensureManagedRole(
    orgId: string,
    principal: ResourcePermissionPrincipal,
  ): Promise<Role> {
    const name = managedRoleNameFor(principal);
    const uid = managedRoleUidFor(principal);
    const existing = await this.deps.roles.findByName(orgId, name);
    if (existing) return existing;
    return this.deps.roles.create({
      orgId,
      name,
      uid,
      displayName: null,
      description: 'Managed role for per-resource permissions',
      groupName: null,
      hidden: true,
    });
  }

  private async syncActionsForRole(
    roleId: string,
    scope: string,
    desiredActions: readonly string[],
  ): Promise<void> {
    const existing = await this.deps.permissions.listByRole(roleId);
    const atScope = existing.filter((p) => p.scope === scope);
    const want = new Set(desiredActions);
    // Remove rows we no longer need.
    for (const row of atScope) {
      if (!want.has(row.action)) {
        await this.deps.permissions.delete(row.id);
      } else {
        want.delete(row.action); // already present, no need to re-insert
      }
    }
    // Add the new ones.
    for (const action of want) {
      await this.deps.permissions.create({ roleId, action, scope });
    }
  }

  private async ensureAssignment(
    orgId: string,
    principal: ResourcePermissionPrincipal,
    roleId: string,
  ): Promise<void> {
    if (principal.kind === 'user') {
      const rows = await this.deps.userRoles.listByUser(principal.userId, orgId);
      if (rows.some((r) => r.roleId === roleId)) return;
      await this.deps.userRoles.create({ orgId, userId: principal.userId, roleId });
    } else if (principal.kind === 'team') {
      const rows = await this.deps.teamRoles.listByTeam(principal.teamId, orgId);
      if (rows.some((r) => r.roleId === roleId)) return;
      await this.deps.teamRoles.create({ orgId, teamId: principal.teamId, roleId });
    } else {
      const existing = await this.deps.roles.findBuiltinRole(
        principal.role,
        orgId,
        roleId,
      );
      if (existing) return;
      await this.deps.roles.upsertBuiltinRole({
        role: principal.role,
        orgId,
        roleId,
      });
    }
  }

  private async removeGrant(
    orgId: string,
    principal: ResourcePermissionPrincipal,
    scope: string,
  ): Promise<void> {
    const name = managedRoleNameFor(principal);
    const role = await this.deps.roles.findByName(orgId, name);
    if (!role) return;
    const rows = await this.deps.permissions.listByRole(role.id);
    for (const r of rows) {
      if (r.scope === scope) await this.deps.permissions.delete(r.id);
    }
  }
}
