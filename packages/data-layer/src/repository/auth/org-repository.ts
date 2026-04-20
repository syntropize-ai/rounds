import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type {
  IOrgRepository,
  ListOptions,
  OrgWithUserCount,
  Page,
} from '@agentic-obs/common';
import type { Org, NewOrg, OrgPatch } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface OrgRow {
  id: string;
  version: number;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  billing_email: string | null;
  created: string;
  updated: string;
}

function rowToOrg(r: OrgRow): Org {
  return {
    id: r.id,
    version: r.version,
    name: r.name,
    address1: r.address1 ?? undefined,
    address2: r.address2 ?? undefined,
    city: r.city ?? undefined,
    state: r.state ?? undefined,
    zipCode: r.zip_code ?? undefined,
    country: r.country ?? undefined,
    billingEmail: r.billing_email ?? undefined,
    created: r.created,
    updated: r.updated,
  };
}

export class OrgRepository implements IOrgRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewOrg): Promise<Org> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO org (
        id, version, name, address1, address2, city, state, zip_code,
        country, billing_email, created, updated
      ) VALUES (
        ${id}, 0, ${input.name},
        ${input.address1 ?? null}, ${input.address2 ?? null},
        ${input.city ?? null}, ${input.state ?? null},
        ${input.zipCode ?? null}, ${input.country ?? null},
        ${input.billingEmail ?? null},
        ${now}, ${now}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[OrgRepository] create: inserted row not found for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<Org | null> {
    const rows = this.db.all<OrgRow>(sql`SELECT * FROM org WHERE id = ${id}`);
    return rows[0] ? rowToOrg(rows[0]) : null;
  }

  async findByName(name: string): Promise<Org | null> {
    const rows = this.db.all<OrgRow>(sql`SELECT * FROM org WHERE name = ${name}`);
    return rows[0] ? rowToOrg(rows[0]) : null;
  }

  async list(opts: ListOptions = {}): Promise<Page<Org>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db.all<OrgRow>(
      sql`SELECT * FROM org ORDER BY name LIMIT ${limit} OFFSET ${offset}`,
    );
    const totalRow = this.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM org`);
    return { items: rows.map(rowToOrg), total: totalRow[0]?.n ?? 0 };
  }

  async listWithUserCounts(
    opts: ListOptions = {},
  ): Promise<Page<OrgWithUserCount>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    // LEFT JOIN so orgs with zero members still appear (count = 0). We alias
    // the aggregate to `user_count` to avoid colliding with any reserved
    // word across sqlite quoting styles; the mapper then reads `user_count`.
    const rows = this.db.all<OrgRow & { user_count: number }>(sql`
      SELECT o.*, COUNT(ou.user_id) AS user_count
      FROM org o
      LEFT JOIN org_user ou ON ou.org_id = o.id
      GROUP BY o.id
      ORDER BY o.name
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRow = this.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM org`);
    return {
      items: rows.map((r) => ({ ...rowToOrg(r), userCount: r.user_count ?? 0 })),
      total: totalRow[0]?.n ?? 0,
    };
  }

  async update(id: string, patch: OrgPatch): Promise<Org | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = nowIso();
    const merged = {
      name: patch.name ?? existing.name,
      address1: patch.address1 !== undefined ? patch.address1 : (existing.address1 ?? null),
      address2: patch.address2 !== undefined ? patch.address2 : (existing.address2 ?? null),
      city: patch.city !== undefined ? patch.city : (existing.city ?? null),
      state: patch.state !== undefined ? patch.state : (existing.state ?? null),
      zipCode: patch.zipCode !== undefined ? patch.zipCode : (existing.zipCode ?? null),
      country: patch.country !== undefined ? patch.country : (existing.country ?? null),
      billingEmail: patch.billingEmail !== undefined ? patch.billingEmail : (existing.billingEmail ?? null),
    };
    this.db.run(sql`
      UPDATE org SET
        version = version + 1,
        name = ${merged.name},
        address1 = ${merged.address1},
        address2 = ${merged.address2},
        city = ${merged.city},
        state = ${merged.state},
        zip_code = ${merged.zipCode},
        country = ${merged.country},
        billing_email = ${merged.billingEmail},
        updated = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM org WHERE id = ${id}`);
    return true;
  }
}
