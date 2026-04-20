import { sql, type SQL } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type {
  IOrgUserRepository,
  ListOrgUsersOptions,
  OrgUserWithOrgName,
  OrgUserWithProfile,
  Page,
} from '@agentic-obs/common';
import type { OrgUser, NewOrgUser, OrgRole } from '@agentic-obs/common';
import { uid, nowIso, toBool } from './shared.js';

interface OrgUserRow {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  created: string;
  updated: string;
}

interface OrgUserWithProfileRow extends OrgUserRow {
  email: string;
  name: string;
  login: string;
  is_service_account: number;
}

function rowTo(r: OrgUserRow): OrgUser {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    role: r.role as OrgRole,
    created: r.created,
    updated: r.updated,
  };
}

function rowToWithProfile(r: OrgUserWithProfileRow): OrgUserWithProfile {
  return {
    ...rowTo(r),
    email: r.email,
    name: r.name,
    login: r.login,
    isServiceAccount: toBool(r.is_service_account),
  };
}

export class OrgUserRepository implements IOrgUserRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewOrgUser): Promise<OrgUser> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO org_user (id, org_id, user_id, role, created, updated)
      VALUES (${id}, ${input.orgId}, ${input.userId}, ${input.role}, ${now}, ${now})
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[OrgUserRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<OrgUser | null> {
    const rows = this.db.all<OrgUserRow>(sql`SELECT * FROM org_user WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findMembership(orgId: string, userId: string): Promise<OrgUser | null> {
    const rows = this.db.all<OrgUserRow>(sql`
      SELECT * FROM org_user WHERE org_id = ${orgId} AND user_id = ${userId}
    `);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listUsersByOrg(
    orgId: string,
    opts: ListOrgUsersOptions = {},
  ): Promise<Page<OrgUserWithProfile>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [sql`ou.org_id = ${orgId}`];
    if (opts.search) {
      const pat = `%${opts.search}%`;
      wheres.push(sql`(u.login LIKE ${pat} OR u.email LIKE ${pat} OR u.name LIKE ${pat})`);
    }
    if (opts.isServiceAccount === false) {
      wheres.push(sql`u.is_service_account = 0`);
    } else if (opts.isServiceAccount === true) {
      wheres.push(sql`u.is_service_account = 1`);
    }
    const whereClause = sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `);

    const rows = this.db.all<OrgUserWithProfileRow>(sql`
      SELECT
        ou.id, ou.org_id, ou.user_id, ou.role, ou.created, ou.updated,
        u.email, u.name, u.login, u.is_service_account
      FROM org_user ou
      INNER JOIN user u ON u.id = ou.user_id
      ${whereClause}
      ORDER BY u.login
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n
      FROM org_user ou
      INNER JOIN user u ON u.id = ou.user_id
      ${whereClause}
    `);
    return { items: rows.map(rowToWithProfile), total: totalRows[0]?.n ?? 0 };
  }

  async listOrgsByUser(userId: string): Promise<OrgUser[]> {
    const rows = this.db.all<OrgUserRow>(
      sql`SELECT * FROM org_user WHERE user_id = ${userId}`,
    );
    return rows.map(rowTo);
  }

  async listOrgsByUserWithName(userId: string): Promise<OrgUserWithOrgName[]> {
    const rows = this.db.all<OrgUserRow & { org_name: string }>(sql`
      SELECT ou.id, ou.org_id, ou.user_id, ou.role, ou.created, ou.updated,
             o.name AS org_name
      FROM org_user ou
      INNER JOIN org o ON o.id = ou.org_id
      WHERE ou.user_id = ${userId}
      ORDER BY o.name
    `);
    return rows.map((r) => ({ ...rowTo(r), orgName: r.org_name }));
  }

  async updateRole(orgId: string, userId: string, role: OrgRole): Promise<OrgUser | null> {
    const existing = await this.findMembership(orgId, userId);
    if (!existing) return null;
    const now = nowIso();
    this.db.run(sql`
      UPDATE org_user SET role = ${role}, updated = ${now}
      WHERE org_id = ${orgId} AND user_id = ${userId}
    `);
    return this.findMembership(orgId, userId);
  }

  async remove(orgId: string, userId: string): Promise<boolean> {
    const existing = await this.findMembership(orgId, userId);
    if (!existing) return false;
    this.db.run(
      sql`DELETE FROM org_user WHERE org_id = ${orgId} AND user_id = ${userId}`,
    );
    return true;
  }
}
