/**
 * `FIXED_ROLES` is the catalog of pre-defined RBAC bundles seeded into every
 * organization at startup. Each entry packages together a coherent set of
 * (action, scope) permissions so operators can hand out a capability with a
 * single grant instead of assembling permissions one-by-one.
 *
 * Naming convention:
 *   fixed:<area>:<verb>          — e.g. `fixed:dashboards:reader`,
 *                                   `fixed:datasources:writer`
 *   fixed:<area>.<sub>:<verb>    — used when an area has a finer-grained
 *                                   sub-resource that needs its own role,
 *                                   e.g. `fixed:dashboards.permissions:writer`
 *
 *   <verb> is typically `reader`, `writer`, `creator`, or `admin`. The role's
 *   `uid` is derived by replacing `:` and `.` with `_` (see `def()` below).
 *
 * Each role also carries a `groupName` that the admin UI uses to cluster
 * related roles together in the assignment dropdowns.
 *
 * The catalog below is the source of truth — application code references
 * roles by their `name` string, and the seeder writes them into the `role`
 * and `permission` tables verbatim.
 */

import { ACTIONS, type RbacAction } from './actions.js';

export interface FixedPermission {
  action: RbacAction;
  /** '' = unrestricted for the action's kind. */
  scope: string;
}

export interface FixedRoleDefinition {
  /** role.name stored in the `role` table, e.g. 'fixed:dashboards:reader'. */
  name: string;
  /** role.uid, e.g. 'fixed_dashboards_reader'. */
  uid: string;
  displayName: string;
  description: string;
  /** role.group_name, e.g. 'Dashboards'. Used by admin UI for grouping. */
  groupName: string;
  permissions: readonly FixedPermission[];
  /** Hidden roles exist but aren't shown by default (includeHidden=true filter). */
  hidden?: boolean;
}

// Helper: build a role definition without having to retype every field.
function def(
  name: string,
  displayName: string,
  description: string,
  groupName: string,
  permissions: FixedPermission[],
  opts: { hidden?: boolean } = {},
): FixedRoleDefinition {
  return {
    name,
    uid: name.replace(/[:.]/g, '_'),
    displayName,
    description,
    groupName,
    permissions: Object.freeze(permissions),
    hidden: opts.hidden,
  };
}

// -- Dashboards ------------------------------------------------------------

const DASHBOARDS_READER = def(
  'fixed:dashboards:reader',
  'Dashboards reader',
  'Read dashboards and dashboard permissions.',
  'Dashboards',
  [
    { action: ACTIONS.DashboardsRead, scope: 'dashboards:*' },
    { action: ACTIONS.DashboardsPermissionsRead, scope: 'dashboards:*' },
  ],
);

const DASHBOARDS_WRITER = def(
  'fixed:dashboards:writer',
  'Dashboards writer',
  'Create, update, and delete dashboards plus manage permissions.',
  'Dashboards',
  [
    { action: ACTIONS.DashboardsRead, scope: 'dashboards:*' },
    { action: ACTIONS.DashboardsWrite, scope: 'dashboards:*' },
    { action: ACTIONS.DashboardsCreate, scope: 'folders:*' },
    { action: ACTIONS.DashboardsDelete, scope: 'dashboards:*' },
    { action: ACTIONS.DashboardsPermissionsRead, scope: 'dashboards:*' },
    { action: ACTIONS.DashboardsPermissionsWrite, scope: 'dashboards:*' },
  ],
);

const DASHBOARDS_CREATOR = def(
  'fixed:dashboards:creator',
  'Dashboards creator',
  'Create dashboards in any folder.',
  'Dashboards',
  [{ action: ACTIONS.DashboardsCreate, scope: 'folders:*' }],
);

const DASHBOARDS_PERMISSIONS_READER = def(
  'fixed:dashboards.permissions:reader',
  'Dashboard permissions reader',
  'Read dashboard permission assignments.',
  'Dashboards',
  [{ action: ACTIONS.DashboardsPermissionsRead, scope: 'dashboards:*' }],
);

const DASHBOARDS_PERMISSIONS_WRITER = def(
  'fixed:dashboards.permissions:writer',
  'Dashboard permissions writer',
  'Change dashboard permission assignments.',
  'Dashboards',
  [
    { action: ACTIONS.DashboardsPermissionsRead, scope: 'dashboards:*' },
    { action: ACTIONS.DashboardsPermissionsWrite, scope: 'dashboards:*' },
  ],
);

// -- Folders --------------------------------------------------------------

const FOLDERS_READER = def(
  'fixed:folders:reader',
  'Folders reader',
  'Read folders and folder permissions.',
  'Folders',
  [
    { action: ACTIONS.FoldersRead, scope: 'folders:*' },
    { action: ACTIONS.FoldersPermissionsRead, scope: 'folders:*' },
  ],
);

const FOLDERS_WRITER = def(
  'fixed:folders:writer',
  'Folders writer',
  'Create, update, and delete folders plus manage permissions.',
  'Folders',
  [
    { action: ACTIONS.FoldersRead, scope: 'folders:*' },
    { action: ACTIONS.FoldersWrite, scope: 'folders:*' },
    { action: ACTIONS.FoldersCreate, scope: '' },
    { action: ACTIONS.FoldersDelete, scope: 'folders:*' },
    { action: ACTIONS.FoldersPermissionsRead, scope: 'folders:*' },
    { action: ACTIONS.FoldersPermissionsWrite, scope: 'folders:*' },
  ],
);

const FOLDERS_CREATOR = def(
  'fixed:folders:creator',
  'Folders creator',
  'Create new folders.',
  'Folders',
  [{ action: ACTIONS.FoldersCreate, scope: '' }],
);

const FOLDERS_PERMISSIONS_READER = def(
  'fixed:folders.permissions:reader',
  'Folder permissions reader',
  'Read folder permission assignments.',
  'Folders',
  [{ action: ACTIONS.FoldersPermissionsRead, scope: 'folders:*' }],
);

const FOLDERS_PERMISSIONS_WRITER = def(
  'fixed:folders.permissions:writer',
  'Folder permissions writer',
  'Change folder permission assignments.',
  'Folders',
  [
    { action: ACTIONS.FoldersPermissionsRead, scope: 'folders:*' },
    { action: ACTIONS.FoldersPermissionsWrite, scope: 'folders:*' },
  ],
);

// -- Datasources ----------------------------------------------------------

const DATASOURCES_READER = def(
  'fixed:datasources:reader',
  'Datasources reader',
  'Read datasources and their configuration.',
  'Datasources',
  [
    { action: ACTIONS.DatasourcesRead, scope: 'datasources:*' },
    { action: ACTIONS.DatasourcesIdRead, scope: 'datasources:*' },
  ],
);

const DATASOURCES_WRITER = def(
  'fixed:datasources:writer',
  'Datasources writer',
  'Create, update, and delete datasources.',
  'Datasources',
  [
    { action: ACTIONS.DatasourcesRead, scope: 'datasources:*' },
    { action: ACTIONS.DatasourcesWrite, scope: 'datasources:*' },
    { action: ACTIONS.DatasourcesCreate, scope: '' },
    { action: ACTIONS.DatasourcesDelete, scope: 'datasources:*' },
    { action: ACTIONS.DatasourcesIdRead, scope: 'datasources:*' },
  ],
);

const DATASOURCES_CREATOR = def(
  'fixed:datasources:creator',
  'Datasources creator',
  'Create new datasources.',
  'Datasources',
  [{ action: ACTIONS.DatasourcesCreate, scope: '' }],
);

const DATASOURCES_EXPLORER = def(
  'fixed:datasources:explorer',
  'Datasources explorer',
  'Use Explore to run ad-hoc queries.',
  'Datasources',
  [{ action: ACTIONS.DatasourcesExplore, scope: '' }],
);

const DATASOURCES_PERMISSIONS_READER = def(
  'fixed:datasources.permissions:reader',
  'Datasource permissions reader',
  'Read datasource permission assignments.',
  'Datasources',
  [{ action: ACTIONS.DatasourcesPermissionsRead, scope: 'datasources:*' }],
);

const DATASOURCES_PERMISSIONS_WRITER = def(
  'fixed:datasources.permissions:writer',
  'Datasource permissions writer',
  'Change datasource permission assignments.',
  'Datasources',
  [
    { action: ACTIONS.DatasourcesPermissionsRead, scope: 'datasources:*' },
    { action: ACTIONS.DatasourcesPermissionsWrite, scope: 'datasources:*' },
  ],
);

const DATASOURCES_ID_READER = def(
  'fixed:datasources.id:reader',
  'Datasource ID reader',
  'Resolve datasource numeric IDs from UIDs (internal).',
  'Datasources',
  [{ action: ACTIONS.DatasourcesIdRead, scope: 'datasources:*' }],
  { hidden: true },
);

// -- Users (server-admin scope) ------------------------------------------

const USERS_READER = def(
  'fixed:users:reader',
  'Users reader',
  'Read user accounts and their authentication info.',
  'Users',
  [
    { action: ACTIONS.UsersRead, scope: 'global.users:*' },
    { action: ACTIONS.UsersAuthTokenRead, scope: 'global.users:*' },
    { action: ACTIONS.UsersQuotasList, scope: 'global.users:*' },
  ],
);

const USERS_WRITER = def(
  'fixed:users:writer',
  'Users writer',
  'Create, update, delete, disable, and manage passwords for user accounts.',
  'Users',
  [
    { action: ACTIONS.UsersRead, scope: 'global.users:*' },
    { action: ACTIONS.UsersWrite, scope: 'global.users:*' },
    { action: ACTIONS.UsersCreate, scope: '' },
    { action: ACTIONS.UsersDelete, scope: 'global.users:*' },
    { action: ACTIONS.UsersDisable, scope: 'global.users:*' },
    { action: ACTIONS.UsersAuthTokenRead, scope: 'global.users:*' },
    { action: ACTIONS.UsersAuthTokenUpdate, scope: 'global.users:*' },
    { action: ACTIONS.UsersPasswordUpdate, scope: 'global.users:*' },
    { action: ACTIONS.UsersPermissionsRead, scope: 'global.users:*' },
    { action: ACTIONS.UsersPermissionsWrite, scope: 'global.users:*' },
    { action: ACTIONS.UsersQuotasList, scope: 'global.users:*' },
    { action: ACTIONS.UsersQuotasUpdate, scope: 'global.users:*' },
  ],
);

// -- Org users -----------------------------------------------------------

const ORG_USERS_READER = def(
  'fixed:org.users:reader',
  'Organization users reader',
  'Read the current organization\u2019s membership.',
  'Organizations',
  [{ action: ACTIONS.OrgUsersRead, scope: 'users:*' }],
);

const ORG_USERS_WRITER = def(
  'fixed:org.users:writer',
  'Organization users writer',
  'Add, remove, and change roles of members in the current organization.',
  'Organizations',
  [
    { action: ACTIONS.OrgUsersRead, scope: 'users:*' },
    { action: ACTIONS.OrgUsersAdd, scope: 'users:*' },
    { action: ACTIONS.OrgUsersWrite, scope: 'users:*' },
    { action: ACTIONS.OrgUsersRemove, scope: 'users:*' },
  ],
);

// -- Orgs ----------------------------------------------------------------

const ORGS_READER = def(
  'fixed:orgs:reader',
  'Organizations reader',
  'Read organization metadata, preferences, and quotas.',
  'Organizations',
  [
    { action: ACTIONS.OrgsRead, scope: '' },
    { action: ACTIONS.OrgsPreferencesRead, scope: '' },
    { action: ACTIONS.OrgsQuotasRead, scope: '' },
  ],
);

const ORGS_WRITER = def(
  'fixed:orgs:writer',
  'Organizations writer',
  'Update organization metadata, preferences, and quotas.',
  'Organizations',
  [
    { action: ACTIONS.OrgsRead, scope: '' },
    { action: ACTIONS.OrgsWrite, scope: '' },
    { action: ACTIONS.OrgsPreferencesRead, scope: '' },
    { action: ACTIONS.OrgsPreferencesWrite, scope: '' },
    { action: ACTIONS.OrgsQuotasRead, scope: '' },
    { action: ACTIONS.OrgsQuotasWrite, scope: '' },
  ],
);

const ORGS_CREATOR = def(
  'fixed:orgs:creator',
  'Organizations creator',
  'Create new organizations (server admin scope).',
  'Organizations',
  [{ action: ACTIONS.OrgsCreate, scope: '' }],
);

// -- Teams ---------------------------------------------------------------

const TEAMS_READER = def(
  'fixed:teams:reader',
  'Teams reader',
  'Read teams and their members.',
  'Teams',
  [{ action: ACTIONS.TeamsRead, scope: 'teams:*' }],
);

const TEAMS_WRITER = def(
  'fixed:teams:writer',
  'Teams writer',
  'Create, update, and delete teams.',
  'Teams',
  [
    { action: ACTIONS.TeamsRead, scope: 'teams:*' },
    { action: ACTIONS.TeamsWrite, scope: 'teams:*' },
    { action: ACTIONS.TeamsCreate, scope: '' },
    { action: ACTIONS.TeamsDelete, scope: 'teams:*' },
    { action: ACTIONS.TeamsPermissionsRead, scope: 'teams:*' },
    { action: ACTIONS.TeamsPermissionsWrite, scope: 'teams:*' },
  ],
);

const TEAMS_CREATOR = def(
  'fixed:teams:creator',
  'Teams creator',
  'Create new teams in the current organization.',
  'Teams',
  [{ action: ACTIONS.TeamsCreate, scope: '' }],
);

// -- Service accounts ----------------------------------------------------

const SA_READER = def(
  'fixed:serviceaccounts:reader',
  'Service accounts reader',
  'Read service accounts and their tokens.',
  'Service Accounts',
  [
    { action: ACTIONS.ServiceAccountsRead, scope: 'serviceaccounts:*' },
    { action: ACTIONS.ServiceAccountsPermissionsRead, scope: 'serviceaccounts:*' },
  ],
);

const SA_WRITER = def(
  'fixed:serviceaccounts:writer',
  'Service accounts writer',
  'Create, update, delete service accounts and manage their tokens.',
  'Service Accounts',
  [
    { action: ACTIONS.ServiceAccountsRead, scope: 'serviceaccounts:*' },
    { action: ACTIONS.ServiceAccountsWrite, scope: 'serviceaccounts:*' },
    { action: ACTIONS.ServiceAccountsDelete, scope: 'serviceaccounts:*' },
    { action: ACTIONS.ServiceAccountsPermissionsRead, scope: 'serviceaccounts:*' },
    { action: ACTIONS.ServiceAccountsPermissionsWrite, scope: 'serviceaccounts:*' },
  ],
);

const SA_CREATOR = def(
  'fixed:serviceaccounts:creator',
  'Service accounts creator',
  'Create new service accounts.',
  'Service Accounts',
  [{ action: ACTIONS.ServiceAccountsCreate, scope: '' }],
);

// -- Roles ---------------------------------------------------------------

const ROLES_READER = def(
  'fixed:roles:reader',
  'Roles reader',
  'Read RBAC roles and permission assignments.',
  'Roles',
  [{ action: ACTIONS.RolesRead, scope: 'roles:*' }],
);

const ROLES_WRITER = def(
  'fixed:roles:writer',
  'Roles writer',
  'Create, update, and delete custom RBAC roles.',
  'Roles',
  [
    { action: ACTIONS.RolesRead, scope: 'roles:*' },
    { action: ACTIONS.RolesWrite, scope: 'roles:*' },
    { action: ACTIONS.RolesDelete, scope: 'roles:*' },
  ],
);

// -- Annotations ---------------------------------------------------------

const ANNOTATIONS_READER = def(
  'fixed:annotations:reader',
  'Annotations reader',
  'Read annotations on dashboards.',
  'Annotations',
  [{ action: ACTIONS.AnnotationsRead, scope: 'annotations:*' }],
);

const ANNOTATIONS_WRITER = def(
  'fixed:annotations:writer',
  'Annotations writer',
  'Create, update, and delete annotations on dashboards.',
  'Annotations',
  [
    { action: ACTIONS.AnnotationsRead, scope: 'annotations:*' },
    { action: ACTIONS.AnnotationsWrite, scope: 'annotations:*' },
    { action: ACTIONS.AnnotationsCreate, scope: 'annotations:*' },
    { action: ACTIONS.AnnotationsDelete, scope: 'annotations:*' },
  ],
);

// -- Alert rules ---------------------------------------------------------

const ALERT_RULES_READER = def(
  'fixed:alert.rules:reader',
  'Alert rules reader',
  'Read alert rules and their state.',
  'Alerting',
  [{ action: ACTIONS.AlertRulesRead, scope: 'folders:*' }],
);

const ALERT_RULES_WRITER = def(
  'fixed:alert.rules:writer',
  'Alert rules writer',
  'Create, update, and delete alert rules.',
  'Alerting',
  [
    { action: ACTIONS.AlertRulesRead, scope: 'folders:*' },
    { action: ACTIONS.AlertRulesWrite, scope: 'folders:*' },
    { action: ACTIONS.AlertRulesCreate, scope: 'folders:*' },
    { action: ACTIONS.AlertRulesDelete, scope: 'folders:*' },
  ],
);

const ALERT_INSTANCES_READER = def(
  'fixed:alert.instances:reader',
  'Alert instances reader',
  'Read alert rule instances and state history.',
  'Alerting',
  [
    { action: ACTIONS.AlertInstancesRead, scope: '' },
    { action: ACTIONS.AlertInstancesExternalRead, scope: '' },
  ],
);

const ALERT_INSTANCES_WRITER = def(
  'fixed:alert.instances:writer',
  'Alert instances writer',
  'Acknowledge and modify alert instance state.',
  'Alerting',
  [
    { action: ACTIONS.AlertInstancesRead, scope: '' },
    { action: ACTIONS.AlertInstancesExternalRead, scope: '' },
    { action: ACTIONS.AlertInstancesExternalWrite, scope: '' },
  ],
);

const ALERT_NOTIFICATIONS_READER = def(
  'fixed:alert.notifications:reader',
  'Notification channels reader',
  'Read notification channels and policies.',
  'Alerting',
  [{ action: ACTIONS.AlertNotificationsRead, scope: '' }],
);

const ALERT_NOTIFICATIONS_WRITER = def(
  'fixed:alert.notifications:writer',
  'Notification channels writer',
  'Manage notification channels and policies.',
  'Alerting',
  [
    { action: ACTIONS.AlertNotificationsRead, scope: '' },
    { action: ACTIONS.AlertNotificationsWrite, scope: '' },
  ],
);

const ALERT_SILENCES_READER = def(
  'fixed:alert.silences:reader',
  'Alert silences reader',
  'Read alert silences.',
  'Alerting',
  [{ action: ACTIONS.AlertSilencesRead, scope: '' }],
);

const ALERT_SILENCES_CREATOR = def(
  'fixed:alert.silences:creator',
  'Alert silences creator',
  'Create alert silences.',
  'Alerting',
  [
    { action: ACTIONS.AlertSilencesRead, scope: '' },
    { action: ACTIONS.AlertSilencesCreate, scope: '' },
  ],
);

const ALERT_SILENCES_WRITER = def(
  'fixed:alert.silences:writer',
  'Alert silences writer',
  'Create, update, and delete alert silences.',
  'Alerting',
  [
    { action: ACTIONS.AlertSilencesRead, scope: '' },
    { action: ACTIONS.AlertSilencesCreate, scope: '' },
    { action: ACTIONS.AlertSilencesWrite, scope: '' },
  ],
);

const ALERT_PROVISIONING_READER = def(
  'fixed:alert.provisioning:reader',
  'Alert provisioning reader',
  'Read provisioned alerting resources.',
  'Alerting',
  [{ action: ACTIONS.AlertProvisioningRead, scope: '' }],
);

const ALERT_PROVISIONING_WRITER = def(
  'fixed:alert.provisioning:writer',
  'Alert provisioning writer',
  'Manage provisioned alerting resources.',
  'Alerting',
  [
    { action: ACTIONS.AlertProvisioningRead, scope: '' },
    { action: ACTIONS.AlertProvisioningWrite, scope: '' },
  ],
);

// -- Server --------------------------------------------------------------

const SERVER_STATS_READER = def(
  'fixed:server.stats:reader',
  'Server stats reader',
  'Read server-wide statistics.',
  'Server',
  [{ action: ACTIONS.ServerStatsRead, scope: '' }],
);

const SERVER_USAGESTATS_REPORT_READER = def(
  'fixed:server.usagestats.report:reader',
  'Server usage report reader',
  'Read the server usage statistics report.',
  'Server',
  [{ action: ACTIONS.ServerUsageStatsReportRead, scope: '' }],
);

// -- API keys (legacy) ---------------------------------------------------

const APIKEYS_READER = def(
  'fixed:apikeys:reader',
  'API keys reader',
  'List legacy API keys.',
  'API Keys',
  [{ action: ACTIONS.ApiKeysRead, scope: 'apikeys:*' }],
);

const APIKEYS_WRITER = def(
  'fixed:apikeys:writer',
  'API keys writer',
  'Create and delete legacy API keys.',
  'API Keys',
  [
    { action: ACTIONS.ApiKeysRead, scope: 'apikeys:*' },
    { action: ACTIONS.ApiKeysCreate, scope: '' },
    { action: ACTIONS.ApiKeysDelete, scope: 'apikeys:*' },
  ],
);

// -- openobs-specific ---------------------------------------------------

// Roles for openobs-specific features: investigation, approval, chat.

const INVESTIGATIONS_READER = def(
  'fixed:investigations:reader',
  'Investigations reader',
  'Read investigations.',
  'Investigations',
  [{ action: ACTIONS.InvestigationsRead, scope: 'investigations:*' }],
);

const INVESTIGATIONS_WRITER = def(
  'fixed:investigations:writer',
  'Investigations writer',
  'Create, update, and delete investigations.',
  'Investigations',
  [
    { action: ACTIONS.InvestigationsRead, scope: 'investigations:*' },
    { action: ACTIONS.InvestigationsWrite, scope: 'investigations:*' },
    { action: ACTIONS.InvestigationsCreate, scope: '' },
    { action: ACTIONS.InvestigationsDelete, scope: 'investigations:*' },
  ],
);

const APPROVALS_READER = def(
  'fixed:approvals:reader',
  'Approvals reader',
  'Read pending approvals.',
  'Approvals',
  [{ action: ACTIONS.ApprovalsRead, scope: 'approvals:*' }],
);

const APPROVALS_APPROVER = def(
  'fixed:approvals:approver',
  'Approvals approver',
  'Approve or reject pending approvals.',
  'Approvals',
  [
    { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
    { action: ACTIONS.ApprovalsApprove, scope: 'approvals:*' },
  ],
);

const APPROVALS_OVERRIDER = def(
  'fixed:approvals:overrider',
  'Approvals overrider',
  'Override pending approvals regardless of normal policy.',
  'Approvals',
  [
    { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
    { action: ACTIONS.ApprovalsApprove, scope: 'approvals:*' },
    { action: ACTIONS.ApprovalsOverride, scope: 'approvals:*' },
  ],
);

const PLANS_READER = def(
  'fixed:plans:reader',
  'Plans reader',
  'Read remediation plans.',
  'Plans',
  [{ action: ACTIONS.PlansRead, scope: 'plans:*' }],
);

const PLANS_APPROVER = def(
  'fixed:plans:approver',
  'Plans approver',
  'Approve, reject, cancel, and retry remediation plans.',
  'Plans',
  [
    { action: ACTIONS.PlansRead, scope: 'plans:*' },
    { action: ACTIONS.PlansApprove, scope: 'plans:*' },
  ],
);

const PLANS_AUTO_EDITOR = def(
  'fixed:plans:auto_editor',
  'Plans auto-editor (cluster-wide)',
  'Approve a plan in auto-edit mode for ANY namespace (skips per-step approvals). Sensitive — grant explicitly. For namespace-narrowed auto-edit, grant `plans:auto_edit` on a `plans:namespace:<ns>` scope instead of using this fixed role.',
  'Plans',
  [
    { action: ACTIONS.PlansRead, scope: 'plans:*' },
    { action: ACTIONS.PlansApprove, scope: 'plans:*' },
    { action: ACTIONS.PlansAutoEdit, scope: 'plans:*' },
  ],
);

const AGENTS_CONFIG_READER = def(
  'fixed:agents.config:reader',
  'Agents configuration reader',
  'Read agent configuration.',
  'Agents',
  [{ action: ACTIONS.AgentsConfigRead, scope: '' }],
);

const AGENTS_CONFIG_WRITER = def(
  'fixed:agents.config:writer',
  'Agents configuration writer',
  'Change agent configuration.',
  'Agents',
  [
    { action: ACTIONS.AgentsConfigRead, scope: '' },
    { action: ACTIONS.AgentsConfigWrite, scope: '' },
  ],
);

const OPS_CONNECTORS_READER = def(
  'fixed:ops.connectors:reader',
  'Ops connectors reader',
  'Read configured Ops/Kubernetes connectors.',
  'Ops',
  [{ action: ACTIONS.OpsConnectorsRead, scope: 'ops.connectors:*' }],
);

const OPS_CONNECTORS_WRITER = def(
  'fixed:ops.connectors:writer',
  'Ops connectors writer',
  'Create and update Ops/Kubernetes connectors.',
  'Ops',
  [
    { action: ACTIONS.OpsConnectorsRead, scope: 'ops.connectors:*' },
    { action: ACTIONS.OpsConnectorsWrite, scope: 'ops.connectors:*' },
  ],
);

const OPS_COMMANDS_RUNNER = def(
  'fixed:ops.commands:runner',
  'Ops command runner',
  'Run policy-gated Ops/Kubernetes commands through configured connectors.',
  'Ops',
  [
    { action: ACTIONS.OpsConnectorsRead, scope: 'ops.connectors:*' },
    { action: ACTIONS.OpsCommandsRun, scope: 'ops.connectors:*' },
  ],
);

// -- Final catalog --------------------------------------------------------

export const FIXED_ROLE_DEFINITIONS: readonly FixedRoleDefinition[] =
  Object.freeze([
    DASHBOARDS_READER,
    DASHBOARDS_WRITER,
    DASHBOARDS_CREATOR,
    DASHBOARDS_PERMISSIONS_READER,
    DASHBOARDS_PERMISSIONS_WRITER,
    FOLDERS_READER,
    FOLDERS_WRITER,
    FOLDERS_CREATOR,
    FOLDERS_PERMISSIONS_READER,
    FOLDERS_PERMISSIONS_WRITER,
    DATASOURCES_READER,
    DATASOURCES_WRITER,
    DATASOURCES_CREATOR,
    DATASOURCES_EXPLORER,
    DATASOURCES_PERMISSIONS_READER,
    DATASOURCES_PERMISSIONS_WRITER,
    DATASOURCES_ID_READER,
    USERS_READER,
    USERS_WRITER,
    ORG_USERS_READER,
    ORG_USERS_WRITER,
    ORGS_READER,
    ORGS_WRITER,
    ORGS_CREATOR,
    TEAMS_READER,
    TEAMS_WRITER,
    TEAMS_CREATOR,
    SA_READER,
    SA_WRITER,
    SA_CREATOR,
    ROLES_READER,
    ROLES_WRITER,
    ANNOTATIONS_READER,
    ANNOTATIONS_WRITER,
    ALERT_RULES_READER,
    ALERT_RULES_WRITER,
    ALERT_INSTANCES_READER,
    ALERT_INSTANCES_WRITER,
    ALERT_NOTIFICATIONS_READER,
    ALERT_NOTIFICATIONS_WRITER,
    ALERT_SILENCES_READER,
    ALERT_SILENCES_CREATOR,
    ALERT_SILENCES_WRITER,
    ALERT_PROVISIONING_READER,
    ALERT_PROVISIONING_WRITER,
    SERVER_STATS_READER,
    SERVER_USAGESTATS_REPORT_READER,
    APIKEYS_READER,
    APIKEYS_WRITER,
    // openobs extensions
    INVESTIGATIONS_READER,
    INVESTIGATIONS_WRITER,
    APPROVALS_READER,
    APPROVALS_APPROVER,
    APPROVALS_OVERRIDER,
    PLANS_READER,
    PLANS_APPROVER,
    PLANS_AUTO_EDITOR,
    AGENTS_CONFIG_READER,
    AGENTS_CONFIG_WRITER,
    OPS_CONNECTORS_READER,
    OPS_CONNECTORS_WRITER,
    OPS_COMMANDS_RUNNER,
  ]);

/**
 * Lookup by role name. Used by tests and by the seed function when it needs
 * to patch a single fixed role without re-seeding the whole catalog.
 */
export function findFixedRole(name: string): FixedRoleDefinition | undefined {
  return FIXED_ROLE_DEFINITIONS.find((r) => r.name === name);
}
