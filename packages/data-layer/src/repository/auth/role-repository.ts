import { sql, type SQL } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IRoleRepository, ListRolesOptions, Page } from '@agentic-obs/common';
import type {
  Role,
  NewRole,
  RolePatch,
  BuiltinRole,
  NewBuiltinRole,
} from '@agentic-obs/common';
import { uid, nowIso, toBool, fromBool } from './shared.js';

interface RoleRow {
  id: string;
  version: number;
  org_id: string;
  name: string;
  uid: string;
  display_name: string | null;
  description: string | null;
  group_name: string | null;
  hidden: number;
  created: string;
  updated: string;
}

function rowToRole(r: RoleRow): Role {
  return {
    id: r.id,
    version: r.version,
    orgId: r.org_id,
    name: r.name,
    uid: r.uid,
    displayName: r.display_name,
    description: r.description,
    groupName: r.group_name,
    hidden: toBool(r.hidden),
    created: r.created,
    updated: r.updated,
  };
}

interface BuiltinRoleRow {
  id: string;
  role: string;
  role_id: string;
  org_id: string;
  created: string;
  updated: string;
}

function rowToBuiltin(r: BuiltinRoleRow): BuiltinRole {
  return {
    id: r.id,
    role: r.role,
    roleId: r.role_id,
    orgId: r.org_id,
    created: r.created,
    updated: r.updated,
  };
}

export class RoleRepository implements IRoleRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewRole): Promise<Role> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO role (
        id, version, org_id, name, uid, display_name, description,
        group_name, hidden, created, updated
      ) VALUES (
        ${id}, 0, ${input.orgId}, ${input.name}, ${input.uid},
        ${input.displayName ?? null}, ${input.description ?? null},
        ${input.groupName ?? null}, ${fromBool(input.hidden)},
        ${now}, ${now}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[RoleRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<Role | null> {
    const rows = this.db.all<RoleRow>(sql`SELECT * FROM role WHERE id = ${id}`);
    return rows[0] ? rowToRole(rows[0]) : null;
  }

  async findByUid(orgId: string, uidVal: string): Promise<Role | null> {
    const rows = this.db.all<RoleRow>(
      sql`SELECT * FROM role WHERE org_id = ${orgId} AND uid = ${uidVal}`,
    );
    return rows[0] ? rowToRole(rows[0]) : null;
  }

  async findByName(orgId: string, name: string): Promise<Role | null> {
    const rows = this.db.all<RoleRow>(
      sql`SELECT * FROM role WHERE org_id = ${orgId} AND name = ${name}`,
    );
    return rows[0] ? rowToRole(rows[0]) : null;
  }

  async list(opts: ListRolesOptions = {}): Promise<Page<Role>> {
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [];
    if (opts.orgId !== undefined) {
      // If both an org filter and includeGlobal are set, surface both scopes.
      wheres.push(
        opts.includeGlobal
          ? sql`(org_id = ${opts.orgId} OR org_id = '')`
          : sql`org_id = ${opts.orgId}`,
      );
    }
    if (opts.hidden !== undefined) wheres.push(sql`hidden = ${fromBool(opts.hidden)}`);
    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;
    const rows = this.db.all<RoleRow>(sql`
      SELECT * FROM role ${whereClause}
      ORDER BY name
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM role ${whereClause}
    `);
    return { items: rows.map(rowToRole), total: totalRows[0]?.n ?? 0 };
  }

  async update(id: string, patch: RolePatch): Promise<Role | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = nowIso();
    const m = {
      name: patch.name ?? existing.name,
      displayName: patch.displayName !== undefined ? patch.displayName : existing.displayName,
      description: patch.description !== undefined ? patch.description : existing.description,
      groupName: patch.groupName !== undefined ? patch.groupName : existing.groupName,
      hidden: patch.hidden ?? existing.hidden,
    };
    this.db.run(sql`
      UPDATE role SET
        version = version + 1,
        name = ${m.name},
        display_name = ${m.displayName},
        description = ${m.description},
        group_name = ${m.groupName},
        hidden = ${fromBool(m.hidden)},
        updated = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM role WHERE id = ${id}`);
    return true;
  }

  async upsertBuiltinRole(input: NewBuiltinRole): Promise<BuiltinRole> {
    const existing = await this.findBuiltinRole(input.role, input.orgId, input.roleId);
    if (existing) return existing;
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO builtin_role (id, role, role_id, org_id, created, updated)
      VALUES (${id}, ${input.role}, ${input.roleId}, ${input.orgId}, ${now}, ${now})
    `);
    const row = await this.findBuiltinRole(input.role, input.orgId, input.roleId);
    if (!row) throw new Error(`[RoleRepository] upsertBuiltinRole failed for id=${id}`);
    return row;
  }

  async listBuiltinRoles(orgId: string): Promise<BuiltinRole[]> {
    const rows = this.db.all<BuiltinRoleRow>(
      sql`SELECT * FROM builtin_role WHERE org_id = ${orgId} ORDER BY role`,
    );
    return rows.map(rowToBuiltin);
  }

  async findBuiltinRole(role: string, orgId: string, roleId: string): Promise<BuiltinRole | null> {
    const rows = this.db.all<BuiltinRoleRow>(sql`
      SELECT * FROM builtin_role
      WHERE role = ${role} AND org_id = ${orgId} AND role_id = ${roleId}
    `);
    return rows[0] ? rowToBuiltin(rows[0]) : null;
  }

  async removeBuiltinRole(role: string, orgId: string, roleId: string): Promise<boolean> {
    const before = await this.findBuiltinRole(role, orgId, roleId);
    if (!before) return false;
    this.db.run(sql`
      DELETE FROM builtin_role
      WHERE role = ${role} AND org_id = ${orgId} AND role_id = ${roleId}
    `);
    return true;
  }
}
