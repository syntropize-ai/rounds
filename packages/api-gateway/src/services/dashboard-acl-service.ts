/**
 * DashboardAclService — read-only access to the legacy `dashboard_acl` table.
 *
 * New code does not write to `dashboard_acl`; the RBAC `permission` rows are
 * the write path (via ResourcePermissionService). We keep the legacy table as
 * an evaluation fallback so that dashboards migrated from an existing Grafana
 * export remain accessible without a re-grant.
 *
 * See docs/auth-perm-design/07-resource-permissions.md §legacy-dashboard_acl.
 *
 * Evaluation rule: if an `dashboard_acl` row targets the dashboard OR any
 * ancestor folder AND matches the caller (by user_id, team_id, or role) with
 * `permission >= required_level`, the call is allowed regardless of whether
 * the RBAC evaluator returned true. This is the minimum back-compat guarantee
 * Grafana provides; we mirror it.
 */

import type {
  IDashboardAclRepository,
  IFolderRepository,
  ITeamMemberRepository,
  DashboardAcl,
  DashboardAclPermission,
  Identity,
} from '@agentic-obs/common';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { PermissionLevel } from '@agentic-obs/common';

export interface DashboardAclServiceDeps {
  dashboardAcl: IDashboardAclRepository;
  folders: IFolderRepository;
  teamMembers: ITeamMemberRepository;
  /** Raw SQLite — used to look up a dashboard's folder_uid without enlarging
   * the dashboards repository interface (out-of-scope for T7). */
  db: SqliteClient;
}

export interface DashboardAclEntry extends DashboardAcl {
  /** True when the entry is inherited from an ancestor folder. */
  isInherited: boolean;
  /** Folder uid that supplied the permission, when inherited. */
  inheritedFrom?: string;
}

/**
 * Required permission level expressed as a `Permission` bit value. Re-exported
 * for convenience — callers pass 1/2/4 directly, which matches the column.
 */
export type RequiredLevel = DashboardAclPermission;

export class DashboardAclService {
  constructor(private readonly deps: DashboardAclServiceDeps) {}

  /**
   * Read the ACL for the dashboard (uid) and every ancestor folder. Returned
   * rows are annotated with `isInherited` so callers can distinguish direct
   * vs. cascaded grants.
   */
  async getForDashboard(
    orgId: string,
    dashboardUid: string,
  ): Promise<DashboardAclEntry[]> {
    const folderUid = this.folderUidForDashboard(orgId, dashboardUid);
    const out: DashboardAclEntry[] = [];

    // Direct rows — the ACL column is `dashboard_id`, and in our model the
    // dashboards table's PK is the uid (see packages/data-layer dashboard
    // repository — `id` is used as uid). Grafana uses a numeric id; we use
    // a text uid as id per our conventions.
    const direct = await this.deps.dashboardAcl.listByDashboard(dashboardUid);
    for (const r of direct) out.push({ ...r, isInherited: false });

    if (folderUid) {
      const folder = await this.deps.folders.findByUid(orgId, folderUid);
      if (folder) {
        // Walk the folder chain; each folder contributes its ACL rows with
        // isInherited=true.
        const chain = [folder, ...(await this.deps.folders.listAncestors(orgId, folderUid))];
        for (const f of chain) {
          const rows = await this.deps.dashboardAcl.listByFolder(f.id);
          for (const r of rows) {
            out.push({ ...r, isInherited: true, inheritedFrom: f.uid });
          }
        }
      }
    }
    return out;
  }

  /**
   * True when a legacy ACL row (direct or inherited) grants `identity` at
   * least `requiredLevel`. Delegates team membership check to TeamMemberRepo.
   *
   * Used as the fallback in AccessControlService.evaluate when the primary
   * RBAC check fails.
   */
  async grantsAtLeast(
    orgId: string,
    dashboardUid: string,
    identity: Identity,
    requiredLevel: RequiredLevel,
  ): Promise<boolean> {
    const entries = await this.getForDashboard(orgId, dashboardUid);
    if (entries.length === 0) return false;

    // User teams (for team-scoped ACL rows).
    const teamIds = new Set<string>();
    const memberships = await this.deps.teamMembers.listTeamsForUser(
      identity.userId,
      orgId,
    );
    for (const m of memberships) teamIds.add(m.teamId);

    const role = identity.orgRole; // Admin | Editor | Viewer | None

    for (const e of entries) {
      if (e.permission < requiredLevel) continue;
      if (e.userId && e.userId === identity.userId) return true;
      if (e.teamId && teamIds.has(e.teamId)) return true;
      if (e.role && e.role === role) return true;
    }
    return false;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Direct SQL lookup — the dashboards repo doesn't expose folder_uid yet. */
  private folderUidForDashboard(orgId: string, uid: string): string | null {
    const rows = this.deps.db.all<{ folder_uid: string | null }>(
      sql`SELECT folder_uid FROM dashboards WHERE org_id = ${orgId} AND id = ${uid} LIMIT 1`,
    );
    return rows[0]?.folder_uid ?? null;
  }
}

/** Re-export commonly-used PermissionLevel constants for callers. */
export const LEGACY_ACL_PERMISSION = PermissionLevel;
