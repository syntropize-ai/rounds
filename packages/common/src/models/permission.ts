/**
 * Resource-permission shared types.
 *
 * Grafana ref: pkg/services/accesscontrol/resourcepermissions/types.go
 * See docs/auth-perm-design/07-resource-permissions.md.
 *
 * `PermissionLevel` is an integer bitfield with three canonical levels —
 * View/Edit/Admin — mapping to sets of RBAC actions on a concrete resource
 * scope. Integer values match Grafana's (1/2/4) and the
 * `dashboard_acl.permission` legacy column.
 *
 * NOTE: `Permission` as a type alias is already used in `rbac.ts` for the
 * permission-row DTO. This module exports the per-level bitfield as
 * `PermissionLevel` to avoid a name collision.
 */

export const PermissionLevel = {
  View: 1,
  Edit: 2,
  Admin: 4,
} as const;

export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];

/** Resource kinds that support per-resource permissions. */
export type ResourceKind = 'folders' | 'dashboards' | 'datasources' | 'alert.rules';

/** Built-in role names usable as permission principals. */
export type BuiltInRoleName = 'Admin' | 'Editor' | 'Viewer';

/** Discriminated-union principal. One of user/team/builtInRole. */
export type ResourcePermissionPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'role'; role: BuiltInRoleName };

/**
 * One denormalized entry in a resource's permission list. Mirrors Grafana's
 * `resourcePermission` response DTO used by `/api/{resource}/:uid/permissions`.
 */
export interface ResourcePermissionEntry {
  /** Stable id when representing a managed-role row; the role name otherwise. */
  id: string;
  /** Managed role name (e.g. `managed:users:{userId}:permissions`). */
  roleName: string;
  /** True when the row comes from a managed-prefixed role (vs. a custom role). */
  isManaged: boolean;
  /** True when the grant is inherited from an ancestor folder. */
  isInherited: boolean;
  /** Origin when inherited. */
  inheritedFrom?: { type: 'folder'; uid: string; title: string };
  userId?: string;
  userLogin?: string;
  userEmail?: string;
  teamId?: string;
  teamName?: string;
  builtInRole?: BuiltInRoleName;
  /** Highest applicable level across all action rows. */
  permission: PermissionLevel;
  /** Exploded action strings this grant carries. */
  actions: string[];
}

/**
 * Bulk-update item for bulk-set permissions endpoints.
 * `permission=null` removes the grant. Exactly one of the principal fields
 * must be set; validation lives in the service layer.
 */
export interface ResourcePermissionSetItem {
  userId?: string;
  teamId?: string;
  role?: BuiltInRoleName;
  /** `null` means "remove the grant". */
  permission: PermissionLevel | null;
}

/**
 * Expand a permission level into the RBAC action strings it grants on a
 * resource. Both the service (write path) and list renderers use this.
 */
export function actionsForLevel(
  resource: ResourceKind,
  level: PermissionLevel,
): string[] {
  const out: string[] = [];

  // Folders cascade to dashboards + alert rules, so a grant on a folder
  // carries the dashboards/alert.rules action set at the same level. Mirrors
  // Grafana's resourcepermissions store for folders, where the actions array
  // merges dashboards + folders action maps.
  const viewActions: Record<ResourceKind, string[]> = {
    folders: ['folders:read', 'dashboards:read', 'alert.rules:read'],
    dashboards: ['dashboards:read'],
    datasources: ['datasources:query'],
    'alert.rules': ['alert.rules:read'],
  };
  const editActions: Record<ResourceKind, string[]> = {
    folders: [
      'folders:write',
      'folders:delete',
      'dashboards:create',
      'dashboards:write',
      'dashboards:delete',
      'alert.rules:write',
      'alert.rules:create',
      'alert.rules:delete',
    ],
    dashboards: ['dashboards:write', 'dashboards:delete'],
    datasources: ['datasources:write'],
    'alert.rules': ['alert.rules:write', 'alert.rules:create', 'alert.rules:delete'],
  };
  const adminActions: Record<ResourceKind, string[]> = {
    folders: [
      'folders.permissions:read',
      'folders.permissions:write',
      'dashboards.permissions:read',
      'dashboards.permissions:write',
    ],
    dashboards: ['dashboards.permissions:read', 'dashboards.permissions:write'],
    datasources: ['datasources.permissions:read', 'datasources.permissions:write'],
    'alert.rules': ['alert.rules.permissions:read', 'alert.rules.permissions:write'],
  };

  out.push(...viewActions[resource]);
  if (level >= PermissionLevel.Edit) out.push(...editActions[resource]);
  if (level >= PermissionLevel.Admin) out.push(...adminActions[resource]);

  return out;
}

/**
 * Inverse lookup: given a set of granted actions on a scope, return the
 * highest permission level they cover. Used when listing inherited permissions
 * where the storage is action-rows rather than a level column.
 *
 * A set of actions "covers" a level if every action the level grants is
 * present. Highest-level-down so Admin wins when its extras are all present.
 */
export function levelForActions(
  resource: ResourceKind,
  actions: readonly string[],
): PermissionLevel {
  const has = (a: string): boolean => actions.includes(a);
  if (actionsForLevel(resource, PermissionLevel.Admin).every(has)) {
    return PermissionLevel.Admin;
  }
  if (actionsForLevel(resource, PermissionLevel.Edit).every(has)) {
    return PermissionLevel.Edit;
  }
  return PermissionLevel.View;
}

/** Managed-role name for a given principal. Org-scoped. */
export function managedRoleNameFor(
  principal: ResourcePermissionPrincipal,
): string {
  switch (principal.kind) {
    case 'user':
      return `managed:users:${principal.userId}:permissions`;
    case 'team':
      return `managed:teams:${principal.teamId}:permissions`;
    case 'role':
      return `managed:builtins:${principal.role}:permissions`;
  }
}

/** Short stable uid for a managed role. Collision-safe per org + role-name. */
export function managedRoleUidFor(
  principal: ResourcePermissionPrincipal,
): string {
  switch (principal.kind) {
    case 'user':
      return `managed_user_${principal.userId}`;
    case 'team':
      return `managed_team_${principal.teamId}`;
    case 'role':
      return `managed_builtin_${principal.role.toLowerCase()}`;
  }
}
