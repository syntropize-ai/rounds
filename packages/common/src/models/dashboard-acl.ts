/**
 * Grafana ref: pkg/services/dashboards/models.go::DashboardACLInfo
 * See docs/auth-perm-design/01-database-schema.md §dashboard_acl
 *
 * Legacy ACL table kept for Grafana compat. Exactly one of (userId, teamId, role)
 * must be non-null — enforced in application code; Grafana also skips a CHECK
 * constraint here.
 */
export const DASHBOARD_PERMISSION_VIEW = 1;
export const DASHBOARD_PERMISSION_EDIT = 2;
export const DASHBOARD_PERMISSION_ADMIN = 4;
export type DashboardAclPermission =
  | typeof DASHBOARD_PERMISSION_VIEW
  | typeof DASHBOARD_PERMISSION_EDIT
  | typeof DASHBOARD_PERMISSION_ADMIN;

export interface DashboardAcl {
  id: string;
  orgId: string;
  dashboardId: string | null;
  folderId: string | null;
  userId: string | null;
  teamId: string | null;
  /** 'Viewer' | 'Editor' | 'Admin' | null — only set when ACL targets a role. */
  role: string | null;
  permission: DashboardAclPermission;
  created: string;
  updated: string;
}

export interface NewDashboardAcl {
  id?: string;
  orgId: string;
  dashboardId?: string | null;
  folderId?: string | null;
  userId?: string | null;
  teamId?: string | null;
  role?: string | null;
  permission: DashboardAclPermission;
}
