/**
 * Postgres InstanceConfigRepository — integration tests.
 *
 * Guarded by `POSTGRES_TEST_URL`. When the env var is absent the entire
 * suite `describe.skip`s so CI stays green without a Postgres container.
 * To run locally:
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@localhost:5432/openobs_test \
 *     pnpm --filter @agentic-obs/data-layer test
 *
 * Each test truncates the W2 tables in `beforeEach` to isolate state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresInstanceMigrations } from './migrate.js';
import { PostgresInstanceConfigRepository } from './instance-config.js';

const PG_URL = process.env['POSTGRES_TEST_URL'];

// `describe.skip` when no URL — keeps CI green on environments without a
// Postgres container.
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('PostgresInstanceConfigRepository', () => {
  const prevSecret = process.env['SECRET_KEY'];
  let db: DbClient;

  beforeAll(async () => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-instance-config-repositories-xxxxxxxx';
    db = createDbClient({ url: PG_URL! });
    await applyPostgresInstanceMigrations(db);
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE instance_llm_config, instance_settings`);
  });

  it('getLlm() returns null on a fresh DB', async () => {
    const repo = new PostgresInstanceConfigRepository(db);
    expect(await repo.getLlm()).toBeNull();
  });

  it('setLlm() then getLlm() round-trips plaintext api key', async () => {
    const repo = new PostgresInstanceConfigRepository(db);
    await repo.setLlm({
      provider: 'anthropic',
      apiKey: 'sk-ant-secret-1234567890',
      model: 'claude-3-opus',
    });
    const cfg = await repo.getLlm();
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe('anthropic');
    expect(cfg!.apiKey).toBe('sk-ant-secret-1234567890');
  });

  it('setLlm() is idempotent and overwrites on second call', async () => {
    const repo = new PostgresInstanceConfigRepository(db);
    await repo.setLlm({ provider: 'anthropic', apiKey: 'k1', model: 'm1' });
    await repo.setLlm({ provider: 'openai', apiKey: 'k2', model: 'm2' });
    const cfg = await repo.getLlm();
    expect(cfg!.provider).toBe('openai');
    expect(cfg!.apiKey).toBe('k2');
  });

  it('ciphertext on disk does not contain plaintext api key', async () => {
    const repo = new PostgresInstanceConfigRepository(db);
    const secret = 'super-secret-api-key-plaintext-do-not-leak';
    await repo.setLlm({ provider: 'anthropic', apiKey: secret, model: 'm' });
    const result = await db.execute(
      sql`SELECT api_key FROM instance_llm_config`,
    );
    const rows = result.rows as unknown as Array<{ api_key: string }>;
    expect(rows[0]!.api_key).not.toContain(secret);
  });

  it('getSetting/setSetting round-trip', async () => {
    const repo = new PostgresInstanceConfigRepository(db);
    expect(await repo.getSetting('bootstrapped_at')).toBeNull();
    await repo.setSetting('bootstrapped_at', '2026-04-18T12:00:00Z');
    expect(await repo.getSetting('bootstrapped_at')).toBe('2026-04-18T12:00:00Z');
    await repo.setSetting('bootstrapped_at', '2026-04-18T13:00:00Z');
    expect(await repo.getSetting('bootstrapped_at')).toBe('2026-04-18T13:00:00Z');
  });

  it('deleteSetting removes the row', async () => {
    const repo = new PostgresInstanceConfigRepository(db);
    await repo.setSetting('key', 'value');
    expect(await repo.deleteSetting('key')).toBe(true);
    expect(await repo.getSetting('key')).toBeNull();
    expect(await repo.deleteSetting('key')).toBe(false);
  });
});
