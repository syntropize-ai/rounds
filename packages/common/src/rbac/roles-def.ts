/**
 * Built-in "basic" role permission bundles. These correspond to the three
 * per-org pseudo-roles (Viewer / Editor / Admin) plus the global Server Admin.
 *
 * Grafana reference (read for semantics, NOT copied):
 *   pkg/services/accesscontrol/roles.go::BasicRolesDefinitions (v11.3.0).
 *
 * The permission set below is an independent enumeration following the
 * specification in docs/auth-perm-design/03-rbac-model.md §built-in-roles.
 * Strings match Grafana because action/scope vocabulary is operator-facing.
 *
 * Invariant: basic:server_admin is the superset. basic:admin ⊇ basic:editor ⊇
 * basic:viewer (that superset relation is computed at seed time — we define
 * each role's unique contributions here, and the seed function unions them).
 */

import { ACTIONS, ALL_ACTIONS, type RbacAction } from './actions.js';

export interface BuiltinPermission {
  action: RbacAction;
  /** `''` = unrestricted for this action's kind (matches empty-scope semantics). */
  scope: string;
}

export interface BasicRoleDefinition {
  /** Role.name stored in the `role` table, e.g. 'basic:viewer'. */
  name: 'basic:viewer' | 'basic:editor' | 'basic:admin' | 'basic:server_admin';
  /** Role.uid in the `role` table, e.g. 'basic_viewer'. */
  uid: string;
  displayName: string;
  description: string;
  /** The org-role name stored in `builtin_role.role` ('Viewer' | 'Editor' | ...). */
  builtinMappingRole: 'Viewer' | 'Editor' | 'Admin' | 'Server Admin';
  /**
   * Whether this role is global-only. Global = org_id='' in storage. Grafana's
   * Server Admin is global; org-level roles (Viewer/Editor/Admin) get one
   * seeded row per org.
   */
  global: boolean;
  /** Permissions this role directly grants (before union with parent role). */
  permissions: readonly BuiltinPermission[];
  /** Optional parent role name — permissions inherited from it. */
  parent?: 'basic:viewer' | 'basic:editor';
}

// -- Viewer ---------------------------------------------------------------

const VIEWER_PERMISSIONS: BuiltinPermission[] = [
  // Read dashboards + folders + annotations.
  { action: ACTIONS.DashboardsRead, scope: 'dashboards:*' },
  { action: ACTIONS.FoldersRead, scope: 'folders:*' },
  { action: ACTIONS.AnnotationsRead, scope: 'annotations:*' },

  // Connector discovery — explore mode only (read-only query).
  { action: ACTIONS.ConnectorsExplore, scope: '' },
  { action: ACTIONS.ConnectorsIdRead, scope: 'connectors:*' },

  // Alert read-only (Grafana: Viewer can see alerts).
  { action: ACTIONS.AlertRulesRead, scope: 'folders:*' },
  { action: ACTIONS.AlertInstancesRead, scope: '' },
  { action: ACTIONS.AlertInstancesExternalRead, scope: '' },
  { action: ACTIONS.AlertNotificationsRead, scope: '' },
  { action: ACTIONS.AlertSilencesRead, scope: '' },

  // Org self-read + preferences (needed for UI bootstrap).
  { action: ACTIONS.OrgsRead, scope: '' },
  { action: ACTIONS.OrgsPreferencesRead, scope: '' },

  // Teams & team members — read-only at viewer level.
  { action: ACTIONS.TeamsRead, scope: 'teams:*' },

  // Read own user quotas (Grafana: Viewer can see their quota).
  { action: ACTIONS.UsersQuotasList, scope: 'global.users:*' },

  // openobs-specific read.
  { action: ACTIONS.InvestigationsRead, scope: 'investigations:*' },
  { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
  { action: ACTIONS.PlansRead, scope: 'plans:*' },
  { action: ACTIONS.ChatUse, scope: '' },
];

// -- Editor (Viewer + write on dashboards/folders/annotations + alert rules)

const EDITOR_ONLY_PERMISSIONS: BuiltinPermission[] = [
  // Dashboard CRUD (Editor can create anywhere, write/delete scoped to dashboards:*).
  { action: ACTIONS.DashboardsCreate, scope: 'folders:*' },
  { action: ACTIONS.DashboardsWrite, scope: 'dashboards:*' },
  { action: ACTIONS.DashboardsDelete, scope: 'dashboards:*' },

  // Folder CRUD.
  { action: ACTIONS.FoldersCreate, scope: '' },
  { action: ACTIONS.FoldersWrite, scope: 'folders:*' },
  { action: ACTIONS.FoldersDelete, scope: 'folders:*' },

  // Connector query (not read/write metadata).
  { action: ACTIONS.ConnectorsQuery, scope: 'connectors:*' },
  { action: ACTIONS.ConnectorsRead, scope: 'connectors:*' },

  // Annotation CRUD.
  { action: ACTIONS.AnnotationsWrite, scope: 'annotations:*' },
  { action: ACTIONS.AnnotationsCreate, scope: 'annotations:*' },
  { action: ACTIONS.AnnotationsDelete, scope: 'annotations:*' },

  // Alert rule CRUD (Grafana editor manages alerts in their folders).
  { action: ACTIONS.AlertRulesWrite, scope: 'folders:*' },
  { action: ACTIONS.AlertRulesCreate, scope: 'folders:*' },
  { action: ACTIONS.AlertRulesDelete, scope: 'folders:*' },
  { action: ACTIONS.AlertNotificationsWrite, scope: '' },
  { action: ACTIONS.AlertInstancesExternalWrite, scope: '' },
  { action: ACTIONS.AlertSilencesCreate, scope: '' },
  { action: ACTIONS.AlertSilencesWrite, scope: '' },

  // openobs-specific write (investigations + approvals interaction).
  { action: ACTIONS.InvestigationsWrite, scope: 'investigations:*' },
  { action: ACTIONS.InvestigationsCreate, scope: '' },
  { action: ACTIONS.InvestigationsDelete, scope: 'investigations:*' },
  { action: ACTIONS.ApprovalsApprove, scope: 'approvals:*' },
  { action: ACTIONS.PlansApprove, scope: 'plans:*' },
];

// -- Admin (Editor + org admin: users/teams/serviceaccounts/roles) ---------

const ADMIN_ONLY_PERMISSIONS: BuiltinPermission[] = [
  // Org user management within this org.
  { action: ACTIONS.OrgUsersRead, scope: 'users:*' },
  { action: ACTIONS.OrgUsersAdd, scope: 'users:*' },
  { action: ACTIONS.OrgUsersWrite, scope: 'users:*' },
  { action: ACTIONS.OrgUsersRemove, scope: 'users:*' },

  // Org self-write + quota read/write.
  { action: ACTIONS.OrgsWrite, scope: '' },
  { action: ACTIONS.OrgsPreferencesWrite, scope: '' },
  { action: ACTIONS.OrgsQuotasRead, scope: '' },
  { action: ACTIONS.OrgsQuotasWrite, scope: '' },

  // Teams CRUD + permission management.
  { action: ACTIONS.TeamsCreate, scope: '' },
  { action: ACTIONS.TeamsWrite, scope: 'teams:*' },
  { action: ACTIONS.TeamsDelete, scope: 'teams:*' },
  { action: ACTIONS.TeamsPermissionsRead, scope: 'teams:*' },
  { action: ACTIONS.TeamsPermissionsWrite, scope: 'teams:*' },

  // Service accounts CRUD.
  { action: ACTIONS.ServiceAccountsRead, scope: 'serviceaccounts:*' },
  { action: ACTIONS.ServiceAccountsWrite, scope: 'serviceaccounts:*' },
  { action: ACTIONS.ServiceAccountsCreate, scope: '' },
  { action: ACTIONS.ServiceAccountsDelete, scope: 'serviceaccounts:*' },
  { action: ACTIONS.ServiceAccountsPermissionsRead, scope: 'serviceaccounts:*' },
  { action: ACTIONS.ServiceAccountsPermissionsWrite, scope: 'serviceaccounts:*' },

  // API keys (legacy).
  { action: ACTIONS.ApiKeysRead, scope: 'apikeys:*' },
  { action: ACTIONS.ApiKeysCreate, scope: '' },
  { action: ACTIONS.ApiKeysDelete, scope: 'apikeys:*' },

  // Roles management within this org (custom roles).
  { action: ACTIONS.RolesRead, scope: 'roles:*' },
  { action: ACTIONS.RolesWrite, scope: 'roles:*' },
  { action: ACTIONS.RolesDelete, scope: 'roles:*' },

  // Connector full CRUD within the org.
  { action: ACTIONS.ConnectorsWrite, scope: 'connectors:*' },
  { action: ACTIONS.ConnectorsCreate, scope: '' },
  { action: ACTIONS.ConnectorsDelete, scope: 'connectors:*' },
  { action: ACTIONS.ConnectorsPermissionsRead, scope: 'connectors:*' },
  { action: ACTIONS.ConnectorsPermissionsWrite, scope: 'connectors:*' },

  // Folder & dashboard permission management.
  { action: ACTIONS.FoldersPermissionsRead, scope: 'folders:*' },
  { action: ACTIONS.FoldersPermissionsWrite, scope: 'folders:*' },
  { action: ACTIONS.DashboardsPermissionsRead, scope: 'dashboards:*' },
  { action: ACTIONS.DashboardsPermissionsWrite, scope: 'dashboards:*' },

  // Alert provisioning.
  { action: ACTIONS.AlertProvisioningRead, scope: '' },
  { action: ACTIONS.AlertProvisioningWrite, scope: '' },

  // openobs-specific admin.
  { action: ACTIONS.ApprovalsOverride, scope: 'approvals:*' },
  // Plans:auto_edit is deliberately NOT granted by default — even Admins. The
  // executor will refuse autoEdit unless the caller has been *explicitly*
  // granted plans:auto_edit (via a fixed-role assignment or a folder-scoped
  // grant). This matches the design-doc requirement that auto-edit be opt-in
  // per user/team, not bundled with the Admin role.
  { action: ACTIONS.AgentsConfigRead, scope: '' },
  { action: ACTIONS.AgentsConfigWrite, scope: '' },
  { action: ACTIONS.ConnectorsRead, scope: 'connectors:*' },
  { action: ACTIONS.ConnectorsWrite, scope: 'connectors:*' },
  { action: ACTIONS.OpsCommandsRun, scope: 'connectors:*' },
  { action: ACTIONS.InstanceConfigRead, scope: '' },
  { action: ACTIONS.InstanceConfigWrite, scope: '' },
];

// -- Server Admin (all actions unrestricted) -------------------------------
//
// Server Admin is the unrestricted role. We grant every action in the catalog
// with scope=''. Expressing it as `*:*:*` would also work, but enumerating
// concrete actions makes listing endpoints / test assertions simpler.

const SERVER_ADMIN_PERMISSIONS: BuiltinPermission[] = ALL_ACTIONS.map(
  (action) => ({ action, scope: '' }),
);

// Additional Server Admin permissions beyond the catalog:
//  - users:* are user-management actions that a Server Admin performs. The
//    catalog covers them already; listing explicitly here would duplicate.
// So we rely on ALL_ACTIONS above.

// -- Assembled role definitions -------------------------------------------

export const BASIC_ROLE_DEFINITIONS: readonly BasicRoleDefinition[] =
  Object.freeze([
    {
      name: 'basic:viewer',
      uid: 'basic_viewer',
      displayName: 'Viewer',
      description: 'Read-only access to dashboards, folders, and annotations.',
      builtinMappingRole: 'Viewer',
      global: false,
      permissions: Object.freeze(VIEWER_PERMISSIONS),
    },
    {
      name: 'basic:editor',
      uid: 'basic_editor',
      displayName: 'Editor',
      description: 'Viewer plus dashboard, folder, annotation, and alert-rule CRUD.',
      builtinMappingRole: 'Editor',
      global: false,
      parent: 'basic:viewer',
      permissions: Object.freeze(EDITOR_ONLY_PERMISSIONS),
    },
    {
      name: 'basic:admin',
      uid: 'basic_admin',
      displayName: 'Admin',
      description:
        'Editor plus org-level admin: users, teams, service accounts, roles.',
      builtinMappingRole: 'Admin',
      global: false,
      parent: 'basic:editor',
      permissions: Object.freeze(ADMIN_ONLY_PERMISSIONS),
    },
    {
      name: 'basic:server_admin',
      uid: 'basic_server_admin',
      displayName: 'Server Admin',
      description:
        'Global: every action unrestricted. Does not automatically grant org-level resource access.',
      builtinMappingRole: 'Server Admin',
      global: true,
      permissions: Object.freeze(SERVER_ADMIN_PERMISSIONS),
    },
  ]);

/**
 * Union each role's own permissions with its ancestor's (transitive) — the
 * shape actually stored in the DB. Idempotent for roles without a `parent`.
 */
export function resolveBasicRolePermissions(
  roleName: BasicRoleDefinition['name'],
): BuiltinPermission[] {
  const byName = new Map<string, BasicRoleDefinition>();
  for (const d of BASIC_ROLE_DEFINITIONS) byName.set(d.name, d);

  const seen = new Set<string>();
  const collected: BuiltinPermission[] = [];

  const walk = (n: BasicRoleDefinition['name']): void => {
    const def = byName.get(n);
    if (!def) return;
    if (def.parent) walk(def.parent);
    for (const p of def.permissions) {
      const key = `${p.action}|${p.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(p);
    }
  };

  walk(roleName);
  return collected;
}
