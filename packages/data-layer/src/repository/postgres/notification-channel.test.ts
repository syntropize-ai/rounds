/**
 * Postgres NotificationChannelRepository — integration tests.
 *
 * See `./instance-config.test.ts` for the POSTGRES_TEST_URL contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresInstanceMigrations } from './migrate.js';
import { PostgresNotificationChannelRepository } from './notification-channel.js';

const PG_URL = process.env['POSTGRES_TEST_URL'];
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('PostgresNotificationChannelRepository', () => {
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
    await db.execute(sql`TRUNCATE notification_channels`);
  });

  it('create/get round-trip with encrypted slack webhook', async () => {
    const repo = new PostgresNotificationChannelRepository(db);
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
    const repo = new PostgresNotificationChannelRepository(db);
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
    const result = await db.execute(
      sql`SELECT config FROM notification_channels WHERE id = ${ch.id}`,
    );
    const rows = result.rows as unknown as Array<{ config: string }>;
    expect(rows[0]!.config).toContain('smtp.example.com');
    expect(rows[0]!.config).not.toContain('smtp-secret-plain');
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
    const repo = new PostgresNotificationChannelRepository(db);
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
    const repo = new PostgresNotificationChannelRepository(db);
    const ch = await repo.create({
      type: 'slack',
      name: 'tmp',
      config: { kind: 'slack', webhookUrl: 'https://x' },
    });
    expect(await repo.delete(ch.id)).toBe(true);
    expect(await repo.get(ch.id)).toBeNull();
  });
});
