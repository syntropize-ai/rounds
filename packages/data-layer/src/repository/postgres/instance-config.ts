/**
 * InstanceConfigRepository (Postgres) — singleton LLM config + KV settings.
 *
 * Postgres sibling of `sqlite/instance-config.ts`. Uses the same table layout
 * (see `migrations/001_instance_settings.sql`) and the same encrypt/decrypt
 * helpers, so the wire format for secrets is identical between backends.
 *
 * Query style: raw `sql` templates via `db.execute(sql)`. This mirrors the
 * SQLite side (`db.run(sql)` / `db.all(sql)`) and avoids tying the W2 tables
 * into `db/schema.ts`, which is shared with the W6 repos we're intentionally
 * leaving SQLite-only.
 */

import { sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import type {
  IInstanceConfigRepository,
  InstanceLlmConfig,
  NewInstanceLlmConfig,
  MaskOptions,
} from '@agentic-obs/common';
import {
  nowIso,
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../sqlite/instance-shared.js';

const SINGLETON_ID = 'singleton';

interface LlmRow {
  id: string;
  provider: string;
  api_key: string | null;
  model: string;
  base_url: string | null;
  auth_type: string | null;
  region: string | null;
  updated_at: string;
  updated_by: string | null;
}

function rowToLlmConfig(r: LlmRow, masked: boolean): InstanceLlmConfig {
  const plainApiKey = decryptSecret(r.api_key);
  return {
    provider: r.provider as InstanceLlmConfig['provider'],
    apiKey: masked ? maskSecret(plainApiKey) : plainApiKey,
    model: r.model,
    baseUrl: r.base_url,
    authType: (r.auth_type ?? null) as InstanceLlmConfig['authType'],
    region: r.region,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export class PostgresInstanceConfigRepository implements IInstanceConfigRepository {
  constructor(private readonly db: DbClient) {}

  async getLlm(opts: MaskOptions = {}): Promise<InstanceLlmConfig | null> {
    const result = await this.db.execute(
      sql`SELECT id, provider, api_key, model, base_url, auth_type, region, updated_at, updated_by
          FROM instance_llm_config WHERE id = ${SINGLETON_ID}`,
    );
    const rows = result.rows as unknown as LlmRow[];
    if (rows.length === 0) return null;
    return rowToLlmConfig(rows[0]!, opts.masked ?? false);
  }

  async setLlm(input: NewInstanceLlmConfig): Promise<InstanceLlmConfig> {
    const now = nowIso();
    const encryptedApiKey = encryptSecret(input.apiKey ?? null);
    await this.db.execute(sql`
      INSERT INTO instance_llm_config (
        id, provider, api_key, model, base_url, auth_type, region,
        updated_at, updated_by
      ) VALUES (
        ${SINGLETON_ID},
        ${input.provider},
        ${encryptedApiKey},
        ${input.model},
        ${input.baseUrl ?? null},
        ${input.authType ?? null},
        ${input.region ?? null},
        ${now},
        ${input.updatedBy ?? null}
      )
      ON CONFLICT(id) DO UPDATE SET
        provider   = excluded.provider,
        api_key    = excluded.api_key,
        model      = excluded.model,
        base_url   = excluded.base_url,
        auth_type  = excluded.auth_type,
        region     = excluded.region,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `);
    const saved = await this.getLlm();
    if (!saved) throw new Error('[PostgresInstanceConfigRepository] setLlm: upsert did not produce a row');
    return saved;
  }

  async clearLlm(): Promise<boolean> {
    const before = await this.getLlm();
    if (!before) return false;
    await this.db.execute(sql`DELETE FROM instance_llm_config WHERE id = ${SINGLETON_ID}`);
    return true;
  }

  async getSetting(key: string): Promise<string | null> {
    const result = await this.db.execute(
      sql`SELECT value FROM instance_settings WHERE key = ${key} LIMIT 1`,
    );
    const rows = result.rows as unknown as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO instance_settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  async deleteSetting(key: string): Promise<boolean> {
    const before = await this.getSetting(key);
    if (before === null) return false;
    await this.db.execute(sql`DELETE FROM instance_settings WHERE key = ${key}`);
    return true;
  }
}
