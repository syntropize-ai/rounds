import { sql, type SQL } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IApiKeyRepository, ListApiKeysOptions, Page } from '@agentic-obs/common';
import type { ApiKey, NewApiKey, ApiKeyPatch } from '@agentic-obs/common';
import { uid, nowIso, toBool, fromBool } from './shared.js';

interface Row {
  id: string;
  org_id: string;
  name: string;
  key: string;
  role: string;
  created: string;
  updated: string;
  last_used_at: string | null;
  expires: string | null;
  service_account_id: string | null;
  owner_user_id: string | null;
  is_revoked: number;
}

function rowTo(r: Row): ApiKey {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    key: r.key,
    role: r.role,
    created: r.created,
    updated: r.updated,
    lastUsedAt: r.last_used_at,
    expires: r.expires,
    serviceAccountId: r.service_account_id,
    ownerUserId: r.owner_user_id,
    isRevoked: toBool(r.is_revoked),
  };
}

export class ApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewApiKey): Promise<ApiKey> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO api_key (
        id, org_id, name, key, role, created, updated, last_used_at,
        expires, service_account_id, owner_user_id, is_revoked
      ) VALUES (
        ${id}, ${input.orgId}, ${input.name}, ${input.key}, ${input.role},
        ${now}, ${now}, NULL, ${input.expires ?? null},
        ${input.serviceAccountId ?? null}, ${input.ownerUserId ?? null}, 0
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[ApiKeyRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<ApiKey | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM api_key WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
    // Active key only — exclude revoked. Expiry is checked by callers (so
    // expired keys still surface here, allowing audit of the "expired"
    // outcome rather than "not found").
    const rows = this.db.all<Row>(sql`
      SELECT * FROM api_key
      WHERE key = ${hashedKey} AND is_revoked = 0
      LIMIT 1
    `);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async list(opts: ListApiKeysOptions = {}): Promise<Page<ApiKey>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [];
    if (opts.orgId !== undefined) wheres.push(sql`org_id = ${opts.orgId}`);
    if (opts.serviceAccountId !== undefined) {
      wheres.push(
        opts.serviceAccountId === null
          ? sql`service_account_id IS NULL`
          : sql`service_account_id = ${opts.serviceAccountId}`,
      );
    }
    if (!opts.includeRevoked) wheres.push(sql`is_revoked = 0`);
    if (!opts.includeExpired) {
      const now = nowIso();
      wheres.push(sql`(expires IS NULL OR expires > ${now})`);
    }
    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;
    const rows = this.db.all<Row>(sql`
      SELECT * FROM api_key ${whereClause}
      ORDER BY created DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM api_key ${whereClause}
    `);
    return { items: rows.map(rowTo), total: totalRows[0]?.n ?? 0 };
  }

  async update(id: string, patch: ApiKeyPatch): Promise<ApiKey | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = nowIso();
    const m = {
      name: patch.name ?? existing.name,
      role: patch.role ?? existing.role,
      lastUsedAt: patch.lastUsedAt !== undefined ? patch.lastUsedAt : existing.lastUsedAt,
      expires: patch.expires !== undefined ? patch.expires : existing.expires,
      isRevoked: patch.isRevoked ?? existing.isRevoked,
    };
    this.db.run(sql`
      UPDATE api_key SET
        name = ${m.name},
        role = ${m.role},
        last_used_at = ${m.lastUsedAt},
        expires = ${m.expires},
        is_revoked = ${fromBool(m.isRevoked)},
        updated = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async revoke(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;
    const now = nowIso();
    this.db.run(
      sql`UPDATE api_key SET is_revoked = 1, updated = ${now} WHERE id = ${id}`,
    );
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM api_key WHERE id = ${id}`);
    return true;
  }

  async touchLastUsed(id: string, at: string): Promise<void> {
    this.db.run(sql`UPDATE api_key SET last_used_at = ${at} WHERE id = ${id}`);
  }
}
