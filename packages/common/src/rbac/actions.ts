/**
 * Action catalog — every operation the RBAC evaluator can gate on.
 *
 * Grafana reference (read for semantics, NOT copied):
 *   pkg/services/accesscontrol/roles.go (canonical list as of v11.3.0).
 *
 * See docs/auth-perm-design/03-rbac-model.md §action-catalog for the full
 * list. Actions are operator-facing vocabulary — the strings themselves are
 * interface facts and are allowed to match Grafana's (per §99 license hygiene).
 * Only the TypeScript enumeration below is original to openobs.
 *
 * Adding a new action:
 *   1. Add a constant below with a descriptive key.
 *   2. If it's openobs-specific (no Grafana counterpart), prefix the comment
 *      with `[openobs-extension]`.
 *   3. If it should appear in a built-in role, update `roles-def.ts` and/or
 *      `fixed-roles-def.ts`.
 */

export const ACTIONS = {
  // -- Dashboards -----------------------------------------------------------
  DashboardsRead: 'dashboards:read',
  DashboardsWrite: 'dashboards:write',
  DashboardsCreate: 'dashboards:create',
  DashboardsDelete: 'dashboards:delete',
  DashboardsPermissionsRead: 'dashboards.permissions:read',
  DashboardsPermissionsWrite: 'dashboards.permissions:write',

  // -- Folders --------------------------------------------------------------
  FoldersRead: 'folders:read',
  FoldersWrite: 'folders:write',
  FoldersCreate: 'folders:create',
  FoldersDelete: 'folders:delete',
  FoldersPermissionsRead: 'folders.permissions:read',
  FoldersPermissionsWrite: 'folders.permissions:write',

  // -- Datasources ----------------------------------------------------------
  DatasourcesRead: 'datasources:read',
  DatasourcesWrite: 'datasources:write',
  DatasourcesCreate: 'datasources:create',
  DatasourcesDelete: 'datasources:delete',
  DatasourcesQuery: 'datasources:query',
  DatasourcesExplore: 'datasources:explore',
  DatasourcesIdRead: 'datasources.id:read',
  DatasourcesPermissionsRead: 'datasources.permissions:read',
  DatasourcesPermissionsWrite: 'datasources.permissions:write',

  // -- Alerting -------------------------------------------------------------
  AlertRulesRead: 'alert.rules:read',
  AlertRulesWrite: 'alert.rules:write',
  AlertRulesCreate: 'alert.rules:create',
  AlertRulesDelete: 'alert.rules:delete',
  AlertRulesPermissionsRead: 'alert.rules.permissions:read',
  AlertRulesPermissionsWrite: 'alert.rules.permissions:write',
  AlertNotificationsRead: 'alert.notifications:read',
  AlertNotificationsWrite: 'alert.notifications:write',
  AlertInstancesRead: 'alert.instances:read',
  AlertInstancesExternalRead: 'alert.instances.external:read',
  AlertInstancesExternalWrite: 'alert.instances.external:write',
  AlertSilencesRead: 'alert.silences:read',
  AlertSilencesCreate: 'alert.silences:create',
  AlertSilencesWrite: 'alert.silences:write',
  AlertProvisioningRead: 'alert.provisioning:read',
  AlertProvisioningWrite: 'alert.provisioning:write',

  // -- Users (server-admin scope) ------------------------------------------
  UsersRead: 'users:read',
  UsersWrite: 'users:write',
  UsersCreate: 'users:create',
  UsersDelete: 'users:delete',
  UsersDisable: 'users:disable',
  UsersAuthTokenRead: 'users.authtoken:read',
  UsersAuthTokenUpdate: 'users.authtoken:update',
  UsersPasswordUpdate: 'users.password:update',
  UsersPermissionsRead: 'users.permissions:read',
  UsersPermissionsWrite: 'users.permissions:write',
  UsersQuotasList: 'users.quotas:list',
  UsersQuotasUpdate: 'users.quotas:update',

  // -- Org users (within an org) -------------------------------------------
  OrgUsersRead: 'org.users:read',
  OrgUsersAdd: 'org.users:add',
  OrgUsersWrite: 'org.users:write',
  OrgUsersRemove: 'org.users:remove',

  // -- Orgs ----------------------------------------------------------------
  OrgsRead: 'orgs:read',
  OrgsWrite: 'orgs:write',
  OrgsCreate: 'orgs:create',
  OrgsDelete: 'orgs:delete',
  OrgsPreferencesRead: 'orgs.preferences:read',
  OrgsPreferencesWrite: 'orgs.preferences:write',
  OrgsQuotasRead: 'orgs.quotas:read',
  OrgsQuotasWrite: 'orgs.quotas:write',

  // -- Teams ---------------------------------------------------------------
  TeamsRead: 'teams:read',
  TeamsWrite: 'teams:write',
  TeamsCreate: 'teams:create',
  TeamsDelete: 'teams:delete',
  TeamsPermissionsRead: 'teams.permissions:read',
  TeamsPermissionsWrite: 'teams.permissions:write',

  // -- Service accounts ----------------------------------------------------
  ServiceAccountsRead: 'serviceaccounts:read',
  ServiceAccountsWrite: 'serviceaccounts:write',
  ServiceAccountsCreate: 'serviceaccounts:create',
  ServiceAccountsDelete: 'serviceaccounts:delete',
  ServiceAccountsPermissionsRead: 'serviceaccounts.permissions:read',
  ServiceAccountsPermissionsWrite: 'serviceaccounts.permissions:write',

  // -- API keys ------------------------------------------------------------
  // Grafana-parity surface at /api/auth/keys. New tokens should be minted via
  // /api/serviceaccounts/:id/tokens, but the legacy route is still live (it
  // transparently creates an SA + token under the hood) so these actions are
  // part of the active RBAC vocabulary, not dead.
  ApiKeysRead: 'apikeys:read',
  ApiKeysCreate: 'apikeys:create',
  ApiKeysDelete: 'apikeys:delete',

  // -- Roles (RBAC admin) --------------------------------------------------
  RolesRead: 'roles:read',
  RolesWrite: 'roles:write',
  RolesDelete: 'roles:delete',

  // -- Server-level --------------------------------------------------------
  ServerStatsRead: 'server.stats:read',
  ServerUsageStatsReportRead: 'server.usagestats.report:read',

  // -- Annotations ---------------------------------------------------------
  AnnotationsRead: 'annotations:read',
  AnnotationsWrite: 'annotations:write',
  AnnotationsCreate: 'annotations:create',
  AnnotationsDelete: 'annotations:delete',

  // -- openobs-specific ----------------------------------------------------
  // [openobs-extension] — investigations / approvals / chat / agents config
  // are not present in Grafana. Naming follows the `kind:verb` Grafana
  // convention so the same evaluator + scope grammar works for them.
  InvestigationsRead: 'investigations:read',
  InvestigationsWrite: 'investigations:write',
  InvestigationsCreate: 'investigations:create',
  InvestigationsDelete: 'investigations:delete',
  ApprovalsRead: 'approvals:read',
  ApprovalsApprove: 'approvals:approve',
  ApprovalsOverride: 'approvals:override',
  ChatUse: 'chat:use',
  AgentsConfigRead: 'agents.config:read',
  AgentsConfigWrite: 'agents.config:write',
  // [openobs-extension] — instance-wide config: LLM provider, notification
  // channels, and dev reset. Granted to Admin+ via ADMIN_ONLY_PERMISSIONS.
  // Lives in the `instance_config` SQLite table (see migration 019). No
  // Grafana counterpart — Grafana scatters these across `settings:*` +
  // provisioning. We pick a single canonical action because they all share
  // the same audience (an Admin configuring the instance).
  InstanceConfigRead: 'instance.config:read',
  InstanceConfigWrite: 'instance.config:write',
} as const;

/**
 * Union of every operator-facing action string.
 *
 * NOTE: intentionally named `RbacAction` (not `Action`) to avoid a collision
 * with the pre-existing domain-level `Action` type in `models/action.ts`
 * (investigation actions). Importers who want the shorter name can alias it:
 * `import type { RbacAction as Action } from '@agentic-obs/common'`.
 */
export type RbacAction = (typeof ACTIONS)[keyof typeof ACTIONS];

/**
 * Readonly snapshot of all known actions. Used at startup to validate that
 * every `permission` row references a known action, and by tests that assert
 * the catalog count.
 */
export const ALL_ACTIONS: readonly RbacAction[] = Object.freeze(
  Object.values(ACTIONS) as RbacAction[],
);

/** True if `s` is a known action (value exists in the catalog). */
export function isKnownAction(s: string): s is RbacAction {
  return (ALL_ACTIONS as readonly string[]).includes(s);
}
