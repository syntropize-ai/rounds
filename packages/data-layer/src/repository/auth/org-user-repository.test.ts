import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { OrgUserRepository } from './org-user-repository.js';
import { OrgRepository } from './org-repository.js';
import { UserRepository } from './user-repository.js';

describe('OrgUserRepository', () => {
  let db: SqliteClient;
  let repo: OrgUserRepository;
  let userRepo: UserRepository;
  let orgRepo: OrgRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new OrgUserRepository(db);
    userRepo = new UserRepository(db);
    orgRepo = new OrgRepository(db);
  });

  it('create() associates a user with an org at a role', async () => {
    const u = await userRepo.create({
      email: 'a@x.test', name: 'A', login: 'ou_a', orgId: 'org_main',
    });
    const ou = await repo.create({ orgId: 'org_main', userId: u.id, role: 'Editor' });
    expect(ou.role).toBe('Editor');
  });

  it('findMembership() returns the unique (org, user) pair', async () => {
    const u = await userRepo.create({
      email: 'b@x.test', name: 'B', login: 'ou_b', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    const ou = await repo.findMembership('org_main', u.id);
    expect(ou!.role).toBe('Viewer');
  });

  it('findMembership() returns null when no row exists', async () => {
    expect(await repo.findMembership('org_main', 'missing')).toBeNull();
  });

  it('listUsersByOrg() joins user profile columns', async () => {
    const u = await userRepo.create({
      email: 'j@x.test', name: 'Jane', login: 'jane', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: u.id, role: 'Admin' });
    const page = await repo.listUsersByOrg('org_main');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.login).toBe('jane');
    expect(page.items[0]!.email).toBe('j@x.test');
  });

  it('listUsersByOrg() filters by search', async () => {
    const a = await userRepo.create({
      email: 'al@x.test', name: 'Al', login: 'alpha', orgId: 'org_main',
    });
    const b = await userRepo.create({
      email: 'be@x.test', name: 'Be', login: 'beta', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: a.id, role: 'Editor' });
    await repo.create({ orgId: 'org_main', userId: b.id, role: 'Editor' });
    const page = await repo.listUsersByOrg('org_main', { search: 'alph' });
    expect(page.items.map((u) => u.login)).toEqual(['alpha']);
  });

  it('listOrgsByUser() returns membership rows across orgs', async () => {
    await orgRepo.create({ id: 'org_2', name: 'Second Org' });
    const u = await userRepo.create({
      email: 'm@x.test', name: 'M', login: 'multi', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: u.id, role: 'Admin' });
    await repo.create({ orgId: 'org_2', userId: u.id, role: 'Editor' });
    const rows = await repo.listOrgsByUser(u.id);
    expect(rows).toHaveLength(2);
  });

  it('updateRole() changes the role and bumps updated', async () => {
    const u = await userRepo.create({
      email: 'r@x.test', name: 'R', login: 'roler', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    const updated = await repo.updateRole('org_main', u.id, 'Admin');
    expect(updated!.role).toBe('Admin');
  });

  it('updateRole() returns null when membership is missing', async () => {
    expect(await repo.updateRole('org_main', 'nope', 'Admin')).toBeNull();
  });

  it('remove() deletes the membership', async () => {
    const u = await userRepo.create({
      email: 'x@x.test', name: 'X', login: 'ou_x', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    expect(await repo.remove('org_main', u.id)).toBe(true);
    expect(await repo.findMembership('org_main', u.id)).toBeNull();
  });

  it('unique (org, user) rejects duplicate memberships', async () => {
    const u = await userRepo.create({
      email: 'd@x.test', name: 'D', login: 'dup_ou', orgId: 'org_main',
    });
    await repo.create({ orgId: 'org_main', userId: u.id, role: 'Editor' });
    await expect(
      repo.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' }),
    ).rejects.toThrow();
  });
});
