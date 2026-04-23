/**
 * DatasourceRepository (Postgres) — CRUD for `instance_datasources`.
 *
 * Postgres sibling of `sqlite/datasource.ts`. Secret columns
 * (api_key, password) are encrypted on write via AES-256-GCM with SECRET_KEY
 * and decrypted on read, using the shared helpers in `sqlite/instance-shared.ts`.
 *
 * Note on `is_default`: Postgres stores this as a real BOOLEAN (the SQLite
 * side stores it as INTEGER 0/1). `toBool` from instance-shared handles both
 * shapes on read, and we pass a raw boolean on write.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import type {
  IDatasourceRepository,
  InstanceDatasource,
  NewInstanceDatasource,
  InstanceDatasourcePatch,
  ListDatasourcesOptions,
  MaskOptions,
} from '@agentic-obs/common';
import {
  uid,
  nowIso,
  toBool,
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../sqlite/instance-shared.js';

interface DatasourceRow {
  id: string;
  org_id: string | null;
  type: string;
  name: string;
  url: string;
  environment: string | null;
  cluster: string | null;
  label: string | null;
  is_default: boolean | number;
  api_key: string | null;
  username: string | null;
  password: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

function rowToDatasource(r: DatasourceRow, masked: boolean): InstanceDatasource {
  const plainApiKey = decryptSecret(r.api_key);
  const plainPassword = decryptSecret(r.password);
  return {
    id: r.id,
    orgId: r.org_id,
    type: r.type as InstanceDatasource['type'],
    name: r.name,
    url: r.url,
    environment: r.environment,
    cluster: r.cluster,
    label: r.label,
    isDefault: toBool(r.is_default),
    apiKey: masked ? maskSecret(plainApiKey) : plainApiKey,
    username: r.username,
    password: masked ? maskSecret(plainPassword) : plainPassword,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export class PostgresDatasourceRepository implements IDatasourceRepository {
  constructor(private readonly db: DbClient) {}

  async list(opts: ListDatasourcesOptions = {}): Promise<InstanceDatasource[]> {
    const wheres: SQL[] = [];
    if (opts.orgId === null) {
      wheres.push(sql`org_id IS NULL`);
    } else if (typeof opts.orgId === 'string') {
      wheres.push(sql`org_id = ${opts.orgId}`);
    }
    if (opts.type) {
      wheres.push(sql`type = ${opts.type}`);
    }
    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;
    const result = await this.db.execute(sql`
      SELECT * FROM instance_datasources ${whereClause}
      ORDER BY name
    `);
    const rows = result.rows as unknown as DatasourceRow[];
    const masked = opts.masked ?? false;
    return rows.map((r) => rowToDatasource(r, masked));
  }

  async get(id: string, opts: MaskOptions = {}): Promise<InstanceDatasource | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM instance_datasources WHERE id = ${id}`,
    );
    const rows = result.rows as unknown as DatasourceRow[];
    if (rows.length === 0) return null;
    return rowToDatasource(rows[0]!, opts.masked ?? false);
  }

  async create(input: NewInstanceDatasource): Promise<InstanceDatasource> {
    const id = input.id ?? `${input.type}-${uid()}`;
    const now = nowIso();
    await this.db.execute(sql`
      INSERT INTO instance_datasources (
        id, org_id, type, name, url, environment, cluster, label,
        is_default, api_key, username, password,
        created_at, updated_at, updated_by
      ) VALUES (
        ${id},
        ${input.orgId ?? null},
        ${input.type},
        ${input.name},
        ${input.url},
        ${input.environment ?? null},
        ${input.cluster ?? null},
        ${input.label ?? null},
        ${input.isDefault ?? false},
        ${encryptSecret(input.apiKey ?? null)},
        ${input.username ?? null},
        ${encryptSecret(input.password ?? null)},
        ${now}, ${now},
        ${input.updatedBy ?? null}
      )
    `);
    const saved = await this.get(id);
    if (!saved) throw new Error(`[PostgresDatasourceRepository] create: row ${id} not found after insert`);
    return saved;
  }

  async update(
    id: string,
    patch: InstanceDatasourcePatch,
  ): Promise<InstanceDatasource | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const now = nowIso();
    const merged = {
      type: patch.type ?? existing.type,
      name: patch.name ?? existing.name,
      url: patch.url ?? existing.url,
      environment: patch.environment !== undefined ? patch.environment : existing.environment,
      cluster: patch.cluster !== undefined ? patch.cluster : existing.cluster,
      label: patch.label !== undefined ? patch.label : existing.label,
      isDefault: patch.isDefault ?? existing.isDefault,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : existing.apiKey,
      username: patch.username !== undefined ? patch.username : existing.username,
      password: patch.password !== undefined ? patch.password : existing.password,
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : existing.updatedBy,
    };
    await this.db.execute(sql`
      UPDATE instance_datasources SET
        type        = ${merged.type},
        name        = ${merged.name},
        url         = ${merged.url},
        environment = ${merged.environment},
        cluster     = ${merged.cluster},
        label       = ${merged.label},
        is_default  = ${merged.isDefault},
        api_key     = ${encryptSecret(merged.apiKey ?? null)},
        username    = ${merged.username},
        password    = ${encryptSecret(merged.password ?? null)},
        updated_at  = ${now},
        updated_by  = ${merged.updatedBy}
      WHERE id = ${id}
    `);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.get(id);
    if (!before) return false;
    await this.db.execute(sql`DELETE FROM instance_datasources WHERE id = ${id}`);
    return true;
  }

  async count(orgId?: string | null): Promise<number> {
    let result;
    if (orgId === undefined) {
      result = await this.db.execute(sql`SELECT COUNT(*) AS n FROM instance_datasources`);
    } else if (orgId === null) {
      result = await this.db.execute(
        sql`SELECT COUNT(*) AS n FROM instance_datasources WHERE org_id IS NULL`,
      );
    } else {
      result = await this.db.execute(
        sql`SELECT COUNT(*) AS n FROM instance_datasources WHERE org_id = ${orgId}`,
      );
    }
    const rows = result.rows as unknown as Array<{ n: number | string }>;
    const n = rows[0]?.n ?? 0;
    // Postgres COUNT() returns bigint → node-pg stringifies it.
    return typeof n === 'string' ? Number.parseInt(n, 10) : n;
  }
}
