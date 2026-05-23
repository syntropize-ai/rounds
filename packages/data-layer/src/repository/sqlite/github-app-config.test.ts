import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqliteGithubAppConfigRepository } from './github-app-config.js';

describe('SqliteGithubAppConfigRepository', () => {
  const prevSecret = process.env['SECRET_KEY'];

  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-github-app-config-repository-xxxxxxx';
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  let db: SqliteClient;
  beforeEach(() => { db = createTestDb(); });

  it('get() returns null when no row exists', async () => {
    const repo = new SqliteGithubAppConfigRepository(db);
    expect(await repo.get('org_main')).toBeNull();
  });

  it('insert() then get() round-trips and decrypts secrets', async () => {
    const repo = new SqliteGithubAppConfigRepository(db);
    const saved = await repo.insert({
      orgId: 'org_main',
      appId: 12345,
      slug: 'rounds-test',
      clientId: 'Iv1.abc',
      clientSecret: 'super-secret',
      privateKey: '-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----',
      webhookSecret: 'wh-shh',
      registeredBy: 'u_1',
    });
    expect(saved.appId).toBe(12345);
    expect(saved.clientSecret).toBe('super-secret');

    const fetched = await repo.get('org_main');
    expect(fetched).not.toBeNull();
    expect(fetched!.clientSecret).toBe('super-secret');
    expect(fetched!.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(fetched!.webhookSecret).toBe('wh-shh');
  });

  it('stored ciphertext is not equal to plaintext', async () => {
    const repo = new SqliteGithubAppConfigRepository(db);
    await repo.insert({
      orgId: 'org_main',
      appId: 1,
      slug: 's',
      clientId: 'c',
      clientSecret: 'plain-cs',
      privateKey: 'plain-pk',
      webhookSecret: null,
      registeredBy: 'u',
    });
    const rows = db.all<{ client_secret_ciphertext: string; private_key_ciphertext: string }>(
      sql`SELECT client_secret_ciphertext, private_key_ciphertext FROM github_app_config WHERE org_id = 'org_main'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_secret_ciphertext).not.toBe('plain-cs');
    expect(rows[0]!.private_key_ciphertext).not.toBe('plain-pk');
  });

  it('insert() upserts when org already has a row', async () => {
    const repo = new SqliteGithubAppConfigRepository(db);
    await repo.insert({
      orgId: 'org_main', appId: 1, slug: 'old', clientId: 'c',
      clientSecret: 's', privateKey: 'p', webhookSecret: null, registeredBy: 'u',
    });
    await repo.insert({
      orgId: 'org_main', appId: 2, slug: 'new', clientId: 'c2',
      clientSecret: 's2', privateKey: 'p2', webhookSecret: null, registeredBy: 'u',
    });
    const fetched = await repo.get('org_main');
    expect(fetched!.slug).toBe('new');
    expect(fetched!.appId).toBe(2);
  });

  it('delete() returns true on existing, false on missing', async () => {
    const repo = new SqliteGithubAppConfigRepository(db);
    expect(await repo.delete('org_main')).toBe(false);
    await repo.insert({
      orgId: 'org_main', appId: 1, slug: 's', clientId: 'c',
      clientSecret: 's', privateKey: 'p', webhookSecret: null, registeredBy: 'u',
    });
    expect(await repo.delete('org_main')).toBe(true);
    expect(await repo.get('org_main')).toBeNull();
  });

  it('get() throws when ciphertext is corrupt', async () => {
    const repo = new SqliteGithubAppConfigRepository(db);
    db.run(sql`
      INSERT INTO github_app_config (
        org_id, app_id, slug, client_id,
        client_secret_ciphertext, private_key_ciphertext, webhook_secret_ciphertext,
        registered_at, registered_by
      ) VALUES (
        'org_main', 1, 's', 'c',
        'not-a-valid-ciphertext', 'also-not-valid', NULL,
        '2026-01-01T00:00:00Z', 'u'
      )
    `);
    await expect(repo.get('org_main')).rejects.toThrow();
  });
});
