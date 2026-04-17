import { sql, type SQL } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { ITeamRepository, ListTeamsOptions, Page } from '@agentic-obs/common';
import type { Team, NewTeam, TeamPatch } from '@agentic-obs/common';
import { uid, nowIso, toBool, fromBool } from './shared.js';

interface Row {
  id: string;
  org_id: string;
  name: string;
  email: string | null;
  external: number;
  created: string;
  updated: string;
}

function rowTo(r: Row): Team {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    email: r.email,
    external: toBool(r.external),
    created: r.created,
    updated: r.updated,
  };
}

export class TeamRepository implements ITeamRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewTeam): Promise<Team> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO team (id, org_id, name, email, external, created, updated)
      VALUES (
        ${id}, ${input.orgId}, ${input.name},
        ${input.email ?? null}, ${fromBool(input.external)},
        ${now}, ${now}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[TeamRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<Team | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM team WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByName(orgId: string, name: string): Promise<Team | null> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM team WHERE org_id = ${orgId} AND name = ${name}`,
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByOrg(orgId: string, opts: ListTeamsOptions = {}): Promise<Page<Team>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [sql`org_id = ${orgId}`];
    if (opts.search) {
      const pat = `%${opts.search}%`;
      wheres.push(sql`name LIKE ${pat}`);
    }
    const whereClause = sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `);
    const rows = this.db.all<Row>(sql`
      SELECT * FROM team ${whereClause}
      ORDER BY name
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM team ${whereClause}
    `);
    return { items: rows.map(rowTo), total: totalRows[0]?.n ?? 0 };
  }

  async update(id: string, patch: TeamPatch): Promise<Team | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = nowIso();
    const m = {
      name: patch.name ?? existing.name,
      email: patch.email !== undefined ? patch.email : existing.email,
      external: patch.external ?? existing.external,
    };
    this.db.run(sql`
      UPDATE team SET
        name = ${m.name},
        email = ${m.email},
        external = ${fromBool(m.external)},
        updated = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM team WHERE id = ${id}`);
    return true;
  }
}
