import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { InstanceConfigRepository } from './instance-config.js';
import { NotificationChannelRepository } from './notification-channel.js';

function seedExtraOrg(db: SqliteClient, id: string): void {
  db.run(sql`
    INSERT INTO org (id, name, created, updated)
    VALUES (${id}, ${id}, datetime('now'), datetime('now'))
  `);
}

describe('instance-config repositories', () => {
  const prevSecret = process.env['SECRET_KEY'];

  beforeAll(() => {
    // AES-GCM needs a ≥32-char key; tests supply one if operator didn't.
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-instance-config-repositories-xxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  let db: SqliteClient;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('InstanceConfigRepository', () => {
    it('getLlm() returns null on a fresh DB', async () => {
      const repo = new InstanceConfigRepository(db);
      expect(await repo.getLlm()).toBeNull();
    });

    it('setLlm() then getLlm() round-trips plaintext api key', async () => {
      const repo = new InstanceConfigRepository(db);
      await repo.setLlm({
        provider: 'anthropic',
        apiKey: 'sk-ant-secret-1234567890',
        model: 'claude-3-opus',
      });
      const cfg = await repo.getLlm();
      expect(cfg).not.toBeNull();
      expect(cfg!.provider).toBe('anthropic');
      expect(cfg!.apiKey).toBe('sk-ant-secret-1234567890');
      expect(cfg!.model).toBe('claude-3-opus');
    });

    it('getLlm({ masked: true }) redacts the api key', async () => {
      const repo = new InstanceConfigRepository(db);
      await repo.setLlm({
        provider: 'openai',
        apiKey: 'sk-openai-live-abcd1234',
        model: 'gpt-4',
      });
      const masked = await repo.getLlm({ masked: true });
      expect(masked!.apiKey).toBe('••••••1234');
    });

    it('setLlm() is idempotent and overwrites on second call', async () => {
      const repo = new InstanceConfigRepository(db);
      await repo.setLlm({ provider: 'anthropic', apiKey: 'k1', model: 'm1' });
      await repo.setLlm({ provider: 'openai', apiKey: 'k2', model: 'm2' });
      const cfg = await repo.getLlm();
      expect(cfg!.provider).toBe('openai');
      expect(cfg!.apiKey).toBe('k2');
    });

    it('ciphertext on disk does not contain plaintext api key', async () => {
      const repo = new InstanceConfigRepository(db);
      const secret = 'super-secret-api-key-plaintext-do-not-leak';
      await repo.setLlm({ provider: 'anthropic', apiKey: secret, model: 'm' });
      // Peek at the raw row
      const row = await import('drizzle-orm').then(({ sql }) =>
        db.all<{ api_key: string }>(sql`SELECT api_key FROM instance_llm_config`),
      );
      expect(row[0]!.api_key).not.toContain(secret);
    });

    it('getSetting/setSetting round-trip', async () => {
      const repo = new InstanceConfigRepository(db);
      expect(await repo.getSetting('bootstrapped_at')).toBeNull();
      await repo.setSetting('bootstrapped_at', '2026-04-18T12:00:00Z');
      expect(await repo.getSetting('bootstrapped_at')).toBe('2026-04-18T12:00:00Z');
      await repo.setSetting('bootstrapped_at', '2026-04-18T13:00:00Z');
      expect(await repo.getSetting('bootstrapped_at')).toBe('2026-04-18T13:00:00Z');
    });
  });

  describe('NotificationChannelRepository', () => {
    it('create/get round-trip with encrypted slack webhook', async () => {
      const repo = new NotificationChannelRepository(db);
      const ch = await repo.create({
        type: 'slack',
        name: 'ops',
        config: { kind: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/XYZ' },
      });
      expect(ch.type).toBe('slack');
      const got = await repo.get(ch.id);
      expect(got!.config).toEqual({
        kind: 'slack',
        webhookUrl: 'https://hooks.slack.com/services/T/B/XYZ',
      });
    });

    it('email config encrypts only password, keeps host/port/from plaintext', async () => {
      const repo = new NotificationChannelRepository(db);
      const ch = await repo.create({
        type: 'email',
        name: 'ops-email',
        config: {
          kind: 'email',
          host: 'smtp.example.com',
          port: 587,
          username: 'bot',
          password: 'smtp-secret-plain',
          from: 'alerts@example.com',
        },
      });
      // Raw row: host and password should both be in the JSON blob, but
      // password as ciphertext, not plaintext.
      const row = await import('drizzle-orm').then(({ sql }) =>
        db.all<{ config: string }>(sql`SELECT config FROM notification_channels WHERE id = ${ch.id}`),
      );
      expect(row[0]!.config).toContain('smtp.example.com');
      expect(row[0]!.config).not.toContain('smtp-secret-plain');
      // Readback decrypts.
      const got = await repo.get(ch.id);
      expect(got!.config).toEqual({
        kind: 'email',
        host: 'smtp.example.com',
        port: 587,
        username: 'bot',
        password: 'smtp-secret-plain',
        from: 'alerts@example.com',
      });
    });

    it('list() filters by type', async () => {
      const repo = new NotificationChannelRepository(db);
      await repo.create({
        type: 'slack',
        name: 's1',
        config: { kind: 'slack', webhookUrl: 'https://a' },
      });
      await repo.create({
        type: 'pagerduty',
        name: 'p1',
        config: { kind: 'pagerduty', integrationKey: 'pd-key' },
      });
      expect((await repo.list({ type: 'slack' })).map((c) => c.name)).toEqual(['s1']);
    });

    it('delete() removes the row', async () => {
      const repo = new NotificationChannelRepository(db);
      const ch = await repo.create({
        type: 'slack',
        name: 'tmp',
        config: { kind: 'slack', webhookUrl: 'https://x' },
      });
      expect(await repo.delete(ch.id)).toBe(true);
      expect(await repo.get(ch.id)).toBeNull();
    });
  });
});
