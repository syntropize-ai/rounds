import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IPermissionRepository } from '@agentic-obs/common';
import type { Permission, NewPermission } from '@agentic-obs/common';
import { parseScope } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface Row {
  id: string;
  role_id: string;
  action: string;
  scope: string;
  kind: string;
  attribute: string;
  identifier: string;
  created: string;
  updated: string;
}

function rowTo(r: Row): Permission {
  return {
    id: r.id,
    roleId: r.role_id,
    action: r.action,
    scope: r.scope,
    kind: r.kind,
    attribute: r.attribute,
    identifier: r.identifier,
    created: r.created,
    updated: r.updated,
  };
}

export class PermissionRepository implements IPermissionRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewPermission): Promise<Permission> {
    const id = input.id ?? uid();
    const now = nowIso();
    const scope = input.scope ?? '';
    const parsed = parseScope(scope);
    this.db.run(sql`
      INSERT INTO permission (
        id, role_id, action, scope, kind, attribute, identifier, created, updated
      ) VALUES (
        ${id}, ${input.roleId}, ${input.action}, ${scope},
        ${parsed.kind}, ${parsed.attribute}, ${parsed.identifier},
        ${now}, ${now}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[PermissionRepository] create failed for id=${id}`);
    return row;
  }

  async createMany(inputs: NewPermission[]): Promise<Permission[]> {
    // Single-connection better-sqlite3 => serial inserts inside the caller's
    // transaction (if any) is fine. If someone wraps this whole call in a
    // `db.transaction(...)`, the batch is atomic.
    const out: Permission[] = [];
    for (const input of inputs) {
      out.push(await this.create(input));
    }
    return out;
  }

  async findById(id: string): Promise<Permission | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM permission WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByRole(roleId: string): Promise<Permission[]> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM permission WHERE role_id = ${roleId} ORDER BY action, scope`,
    );
    return rows.map(rowTo);
  }

  async listByRoles(roleIds: string[]): Promise<Permission[]> {
    if (roleIds.length === 0) return [];
    // Build IN (?, ?, ...) with drizzle's sql.join for safe parameterization.
    const placeholders = sql.join(
      roleIds.map((rid) => sql`${rid}`),
      sql`, `,
    );
    const rows = this.db.all<Row>(sql`
      SELECT * FROM permission WHERE role_id IN (${placeholders})
      ORDER BY role_id, action, scope
    `);
    return rows.map(rowTo);
  }

  async listByAction(action: string): Promise<Permission[]> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM permission WHERE action = ${action}`,
    );
    return rows.map(rowTo);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM permission WHERE id = ${id}`);
    return true;
  }

  async deleteByRole(roleId: string): Promise<number> {
    const before = this.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM permission WHERE role_id = ${roleId}`,
    );
    this.db.run(sql`DELETE FROM permission WHERE role_id = ${roleId}`);
    return before[0]?.n ?? 0;
  }
}
