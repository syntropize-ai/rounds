import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { TeamRepository } from './team-repository.js';

describe('TeamRepository', () => {
  let db: SqliteClient;
  let repo: TeamRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new TeamRepository(db);
  });

  it('create() inserts a team', async () => {
    const t = await repo.create({ orgId: 'org_main', name: 'SRE' });
    expect(t.name).toBe('SRE');
    expect(t.external).toBe(false);
  });

  it('create() can mark as external (LDAP/OIDC synced)', async () => {
    const t = await repo.create({ orgId: 'org_main', name: 'ldap-team', external: true });
    expect(t.external).toBe(true);
  });

  it('findByName() resolves within an org', async () => {
    await repo.create({ orgId: 'org_main', name: 'DevEx' });
    const t = await repo.findByName('org_main', 'DevEx');
    expect(t!.name).toBe('DevEx');
  });

  it('listByOrg() returns teams for an org', async () => {
    await repo.create({ orgId: 'org_main', name: 'T1' });
    await repo.create({ orgId: 'org_main', name: 'T2' });
    const page = await repo.listByOrg('org_main');
    expect(page.total).toBe(2);
  });

  it('listByOrg() filters by search', async () => {
    await repo.create({ orgId: 'org_main', name: 'alpha-team' });
    await repo.create({ orgId: 'org_main', name: 'beta-team' });
    const page = await repo.listByOrg('org_main', { search: 'alph' });
    expect(page.items).toHaveLength(1);
  });

  it('update() mutates name + email', async () => {
    const t = await repo.create({ orgId: 'org_main', name: 'Old' });
    const updated = await repo.update(t.id, { name: 'New', email: 'x@x.test' });
    expect(updated!.name).toBe('New');
    expect(updated!.email).toBe('x@x.test');
  });

  it('update() returns null for unknown id', async () => {
    expect(await repo.update('missing', { name: 'x' })).toBeNull();
  });

  it('delete() removes a team', async () => {
    const t = await repo.create({ orgId: 'org_main', name: 'Gone' });
    expect(await repo.delete(t.id)).toBe(true);
    expect(await repo.findById(t.id)).toBeNull();
  });

  it('unique (org_id, name) rejects duplicates', async () => {
    await repo.create({ orgId: 'org_main', name: 'dup' });
    await expect(repo.create({ orgId: 'org_main', name: 'dup' })).rejects.toThrow();
  });

  it('findById() returns null for unknown id', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });
});
