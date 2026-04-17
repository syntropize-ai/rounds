import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { OrgRepository } from './org-repository.js';

describe('OrgRepository', () => {
  let db: SqliteClient;
  let repo: OrgRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new OrgRepository(db);
  });

  it('create() persists a row and returns the created Org', async () => {
    const org = await repo.create({ name: 'Acme Inc.' });
    expect(org.id).toBeTruthy();
    expect(org.name).toBe('Acme Inc.');
    expect(org.version).toBe(0);
    expect(org.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('create() with an explicit id uses that id', async () => {
    const org = await repo.create({ id: 'org_custom', name: 'Custom Org' });
    expect(org.id).toBe('org_custom');
  });

  it('findById() returns null for unknown id', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findById() returns the seeded default org_main', async () => {
    const row = await repo.findById('org_main');
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Main Org');
  });

  it('findByName() resolves by org name', async () => {
    await repo.create({ name: 'Needle' });
    const found = await repo.findByName('Needle');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Needle');
  });

  it('list() paginates across rows', async () => {
    for (let i = 0; i < 5; i++) await repo.create({ name: `Org${i}` });
    const page = await repo.list({ limit: 3, offset: 0 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(6); // 5 + org_main
  });

  it('update() bumps version and mutates name', async () => {
    const org = await repo.create({ name: 'Before' });
    const updated = await repo.update(org.id, { name: 'After' });
    expect(updated!.name).toBe('After');
    expect(updated!.version).toBe(1);
  });

  it('update() returns null for unknown id', async () => {
    expect(await repo.update('nope', { name: 'x' })).toBeNull();
  });

  it('update() preserves unspecified fields', async () => {
    const org = await repo.create({ name: 'Foo', city: 'Oakland' });
    const updated = await repo.update(org.id, { name: 'Bar' });
    expect(updated!.city).toBe('Oakland');
  });

  it('delete() removes the row and returns true', async () => {
    const org = await repo.create({ name: 'Doomed' });
    expect(await repo.delete(org.id)).toBe(true);
    expect(await repo.findById(org.id)).toBeNull();
  });

  it('delete() returns false for unknown id', async () => {
    expect(await repo.delete('missing')).toBe(false);
  });

  it('rejects duplicate name via unique index', async () => {
    await repo.create({ name: 'UniqueName' });
    await expect(repo.create({ name: 'UniqueName' })).rejects.toThrow();
  });
});
