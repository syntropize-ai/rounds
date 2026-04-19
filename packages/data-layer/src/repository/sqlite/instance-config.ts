/**
 * InstanceConfigRepository — singleton LLM config + KV settings.
 *
 * Backed by `instance_llm_config` and `instance_settings` from migration
 * 019. The LLM table is constrained to a single row (id = 'singleton').
 * Writes go through UPSERT so the first save and every subsequent save
 * use the same path.
 */

import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
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
} from './instance-shared.js';

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
  // Decrypt the api key unless we're masking. Decryption errors are
  // intentionally not caught — if SECRET_KEY rotated out from under us
  // we want to surface that to the operator, not return an empty string.
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

export class InstanceConfigRepository implements IInstanceConfigRepository {
  constructor(private readonly db: SqliteClient) {}

  async getLlm(opts: MaskOptions = {}): Promise<InstanceLlmConfig | null> {
    const rows = this.db.all<LlmRow>(sql`
      SELECT * FROM instance_llm_config WHERE id = ${SINGLETON_ID}
    `);
    if (rows.length === 0) return null;
    return rowToLlmConfig(rows[0]!, opts.masked ?? false);
  }

  async setLlm(input: NewInstanceLlmConfig): Promise<InstanceLlmConfig> {
    const now = nowIso();
    const encryptedApiKey = encryptSecret(input.apiKey ?? null);
    this.db.run(sql`
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
    if (!saved) throw new Error('[InstanceConfigRepository] setLlm: upsert did not produce a row');
    return saved;
  }

  async clearLlm(): Promise<boolean> {
    const before = await this.getLlm();
    if (!before) return false;
    this.db.run(sql`DELETE FROM instance_llm_config WHERE id = ${SINGLETON_ID}`);
    return true;
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = this.db.all<{ value: string }>(
      sql`SELECT value FROM instance_settings WHERE key = ${key} LIMIT 1`,
    );
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db.run(sql`
      INSERT INTO instance_settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  async deleteSetting(key: string): Promise<boolean> {
    const before = await this.getSetting(key);
    if (before === null) return false;
    this.db.run(sql`DELETE FROM instance_settings WHERE key = ${key}`);
    return true;
  }
}
