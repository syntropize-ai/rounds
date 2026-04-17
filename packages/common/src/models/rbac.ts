/**
 * Grafana ref: pkg/services/accesscontrol/models/
 * See docs/auth-perm-design/01-database-schema.md §role, §permission, §builtin_role
 * See docs/auth-perm-design/03-rbac-model.md for the action catalog and semantics.
 */
export interface Role {
  id: string;
  version: number;
  /** '' for global roles; org id for org-scoped roles. */
  orgId: string;
  name: string;
  uid: string;
  displayName: string | null;
  description: string | null;
  groupName: string | null;
  hidden: boolean;
  created: string;
  updated: string;
}

export interface NewRole {
  id?: string;
  orgId: string;
  name: string;
  uid: string;
  displayName?: string | null;
  description?: string | null;
  groupName?: string | null;
  hidden?: boolean;
}

export interface RolePatch {
  name?: string;
  displayName?: string | null;
  description?: string | null;
  groupName?: string | null;
  hidden?: boolean;
}

export interface Permission {
  id: string;
  roleId: string;
  /** e.g. 'dashboards:read'. */
  action: string;
  /** e.g. 'dashboards:uid:abc' or '' for unrestricted. */
  scope: string;
  /** Parsed from scope — first segment. */
  kind: string;
  /** Parsed from scope — second segment. */
  attribute: string;
  /** Parsed from scope — third segment. */
  identifier: string;
  created: string;
  updated: string;
}

export interface NewPermission {
  id?: string;
  roleId: string;
  action: string;
  scope?: string;
}

/**
 * Maps a built-in pseudo-role name ('Viewer' | 'Editor' | 'Admin' | 'Server Admin')
 * to a concrete role row, within an org (or global when orgId='').
 */
export interface BuiltinRole {
  id: string;
  /** 'Viewer' | 'Editor' | 'Admin' | 'Server Admin'. See 01-database-schema.md §builtin_role. */
  role: string;
  roleId: string;
  orgId: string;
  created: string;
  updated: string;
}

export interface NewBuiltinRole {
  id?: string;
  role: string;
  roleId: string;
  orgId: string;
}

/** user_role row — assigns a role directly to a user (beyond their org role). */
export interface UserRole {
  id: string;
  orgId: string;
  userId: string;
  roleId: string;
  created: string;
}

export interface NewUserRole {
  id?: string;
  orgId: string;
  userId: string;
  roleId: string;
}

/** team_role row — assigns a role to a team. */
export interface TeamRole {
  id: string;
  orgId: string;
  teamId: string;
  roleId: string;
  created: string;
}

export interface NewTeamRole {
  id?: string;
  orgId: string;
  teamId: string;
  roleId: string;
}

/**
 * Scope grammar `kind:attribute:identifier`. Parsed into 3 parts and stored
 * denormalized in the permission table for query efficiency (see
 * docs/auth-perm-design/03-rbac-model.md §scope-grammar).
 */
export interface ParsedScope {
  kind: string;
  attribute: string;
  identifier: string;
}

export function parseScope(scope: string): ParsedScope {
  if (scope === '' || scope === undefined || scope === null) {
    return { kind: '*', attribute: '*', identifier: '*' };
  }
  // Grafana parses left-to-right: kind[:attribute[:identifier]]. Missing
  // segments default to '*' (wildcard), matching pkg/services/accesscontrol/models.go.
  const parts = scope.split(':');
  const kind = parts[0] ?? '*';
  const attribute = parts[1] ?? '*';
  // Identifier can contain further colons (e.g. scoped names); join the tail.
  const identifier = parts.length >= 3 ? parts.slice(2).join(':') : '*';
  return { kind, attribute, identifier };
}
