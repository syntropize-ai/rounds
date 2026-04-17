import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IDashboardAclRepository } from '@agentic-obs/common';
import type { DashboardAcl, NewDashboardAcl, DashboardAclPermission } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface Row {
  id: string;
  org_id: string;
  dashboard_id: string | null;
  folder_id: string | null;
  user_id: string | null;
  team_id: string | null;
  role: string | null;
  permission: number;
  created: string;
  updated: string;
}

function rowTo(r: Row): DashboardAcl {
  return {
    id: r.id,
    orgId: r.org_id,
    dashboardId: r.dashboard_id,
    folderId: r.folder_id,
    userId: r.user_id,
    teamId: r.team_id,
    role: r.role,
    permission: r.permission as DashboardAclPermission,
    created: r.created,
    updated: r.updated,
  };
}

/**
 * Enforces the "exactly one of (user_id, team_id, role) is non-null" invariant
 * in application code. Grafana does the same — no CHECK constraint.
 */
function validatePrincipal(input: NewDashboardAcl): void {
  const hits =
    (input.userId ? 1 : 0) + (input.teamId ? 1 : 0) + (input.role ? 1 : 0);
  if (hits !== 1) {
    throw new Error(
      `[DashboardAclRepository] exactly one of (userId, teamId, role) must be set — got ${hits}`,
    );
  }
}

export class DashboardAclRepository implements IDashboardAclRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewDashboardAcl): Promise<DashboardAcl> {
    validatePrincipal(input);
    // A dashboard_acl row targets either a dashboard or a folder but not both.
    if (input.dashboardId && input.folderId) {
      throw new Error(
        `[DashboardAclRepository] an ACL row targets either dashboardId or folderId, not both`,
      );
    }
    if (!input.dashboardId && !input.folderId) {
      throw new Error(
        `[DashboardAclRepository] one of dashboardId / folderId is required`,
      );
    }
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO dashboard_acl (
        id, org_id, dashboard_id, folder_id, user_id, team_id, role,
        permission, created, updated
      ) VALUES (
        ${id}, ${input.orgId},
        ${input.dashboardId ?? null}, ${input.folderId ?? null},
        ${input.userId ?? null}, ${input.teamId ?? null},
        ${input.role ?? null},
        ${input.permission},
        ${now}, ${now}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[DashboardAclRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<DashboardAcl | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM dashboard_acl WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByDashboard(dashboardId: string): Promise<DashboardAcl[]> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM dashboard_acl WHERE dashboard_id = ${dashboardId}`,
    );
    return rows.map(rowTo);
  }

  async listByFolder(folderId: string): Promise<DashboardAcl[]> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM dashboard_acl WHERE folder_id = ${folderId}`,
    );
    return rows.map(rowTo);
  }

  async listByUser(orgId: string, userId: string): Promise<DashboardAcl[]> {
    const rows = this.db.all<Row>(sql`
      SELECT * FROM dashboard_acl WHERE org_id = ${orgId} AND user_id = ${userId}
    `);
    return rows.map(rowTo);
  }

  async listByTeam(orgId: string, teamId: string): Promise<DashboardAcl[]> {
    const rows = this.db.all<Row>(sql`
      SELECT * FROM dashboard_acl WHERE org_id = ${orgId} AND team_id = ${teamId}
    `);
    return rows.map(rowTo);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM dashboard_acl WHERE id = ${id}`);
    return true;
  }

  async deleteByDashboard(dashboardId: string): Promise<number> {
    const before = this.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM dashboard_acl WHERE dashboard_id = ${dashboardId}`,
    );
    this.db.run(sql`DELETE FROM dashboard_acl WHERE dashboard_id = ${dashboardId}`);
    return before[0]?.n ?? 0;
  }

  async deleteByFolder(folderId: string): Promise<number> {
    const before = this.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM dashboard_acl WHERE folder_id = ${folderId}`,
    );
    this.db.run(sql`DELETE FROM dashboard_acl WHERE folder_id = ${folderId}`);
    return before[0]?.n ?? 0;
  }
}
