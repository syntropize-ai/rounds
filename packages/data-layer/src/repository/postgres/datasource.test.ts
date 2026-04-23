/**
 * Postgres DatasourceRepository — integration tests.
 *
 * See `./instance-config.test.ts` for the POSTGRES_TEST_URL contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresInstanceMigrations } from './migrate.js';
import { PostgresDatasourceRepository } from './datasource.js';

const PG_URL = process.env['POSTGRES_TEST_URL'];
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('PostgresDatasourceRepository', () => {
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
    await db.execute(sql`TRUNCATE instance_datasources`);
  });

  it('list() returns [] on empty DB', async () => {
    const repo = new PostgresDatasourceRepository(db);
    expect(await repo.list()).toEqual([]);
  });

  it('create/get/list round-trip with encrypted password', async () => {
    const repo = new PostgresDatasourceRepository(db);
    const ds = await repo.create({
      type: 'prometheus',
      name: 'prod-prom',
      url: 'https://prom.example.com',
      username: 'admin',
      password: 'hunter2',
    });
    expect(ds.name).toBe('prod-prom');
    expect(ds.password).toBe('hunter2');
    const fetched = await repo.get(ds.id);
    expect(fetched!.password).toBe('hunter2');
    const all = await repo.list();
    expect(all).toHaveLength(1);
  });

  it('get({ masked: true }) redacts apiKey and password', async () => {
    const repo = new PostgresDatasourceRepository(db);
    const ds = await repo.create({
      type: 'elasticsearch',
      name: 'logs',
      url: 'https://es.example.com',
      apiKey: 'es-api-key-plaintext-abcd1234',
      password: 'short',
    });
    const masked = await repo.get(ds.id, { masked: true });
    expect(masked!.apiKey).toBe('••••••1234');
    expect(masked!.password).toBe('••••••hort');
  });

  it('update() changes only patched fields', async () => {
    const repo = new PostgresDatasourceRepository(db);
    const ds = await repo.create({
      type: 'prometheus',
      name: 'a',
      url: 'https://a.example.com',
      apiKey: 'old-key',
    });
    const updated = await repo.update(ds.id, { apiKey: 'new-key', name: 'a-renamed' });
    expect(updated!.apiKey).toBe('new-key');
    expect(updated!.name).toBe('a-renamed');
    expect(updated!.url).toBe('https://a.example.com');
  });

  it('delete() removes the row', async () => {
    const repo = new PostgresDatasourceRepository(db);
    const ds = await repo.create({ type: 'prometheus', name: 'tmp', url: 'u' });
    expect(await repo.delete(ds.id)).toBe(true);
    expect(await repo.get(ds.id)).toBeNull();
    expect(await repo.delete(ds.id)).toBe(false);
  });

  it('count() with org filter', async () => {
    const repo = new PostgresDatasourceRepository(db);
    await repo.create({ type: 'prometheus', name: 'g', url: 'u', orgId: null });
    await repo.create({ type: 'prometheus', name: 'o', url: 'u', orgId: 'org_main' });
    expect(await repo.count()).toBe(2);
    expect(await repo.count(null)).toBe(1);
    expect(await repo.count('org_main')).toBe(1);
  });
});
