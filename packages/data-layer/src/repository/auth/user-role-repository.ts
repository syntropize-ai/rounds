import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IUserRoleRepository } from '@agentic-obs/common';
import type { UserRole, NewUserRole } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface Row {
  id: string;
  org_id: string;
  user_id: string;
  role_id: string;
  created: string;
}

function rowTo(r: Row): UserRole {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    roleId: r.role_id,
    created: r.created,
  };
}

export class UserRoleRepository implements IUserRoleRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewUserRole): Promise<UserRole> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO user_role (id, org_id, user_id, role_id, created)
      VALUES (${id}, ${input.orgId}, ${input.userId}, ${input.roleId}, ${now})
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[UserRoleRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<UserRole | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM user_role WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByUser(userId: string, orgId?: string): Promise<UserRole[]> {
    const rows = orgId
      ? this.db.all<Row>(sql`
          SELECT * FROM user_role
          WHERE user_id = ${userId} AND (org_id = ${orgId} OR org_id = '')
        `)
      : this.db.all<Row>(sql`SELECT * FROM user_role WHERE user_id = ${userId}`);
    return rows.map(rowTo);
  }

  async listByRole(roleId: string): Promise<UserRole[]> {
    const rows = this.db.all<Row>(sql`SELECT * FROM user_role WHERE role_id = ${roleId}`);
    return rows.map(rowTo);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM user_role WHERE id = ${id}`);
    return true;
  }

  async remove(orgId: string, userId: string, roleId: string): Promise<boolean> {
    const before = this.db.all<Row>(sql`
      SELECT * FROM user_role
      WHERE org_id = ${orgId} AND user_id = ${userId} AND role_id = ${roleId}
    `);
    if (before.length === 0) return false;
    this.db.run(sql`
      DELETE FROM user_role
      WHERE org_id = ${orgId} AND user_id = ${userId} AND role_id = ${roleId}
    `);
    return true;
  }
}
