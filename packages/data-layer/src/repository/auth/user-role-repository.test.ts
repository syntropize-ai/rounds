import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { UserRoleRepository } from './user-role-repository.js';
import { UserRepository } from './user-repository.js';
import { RoleRepository } from './role-repository.js';

describe('UserRoleRepository', () => {
  let db: SqliteClient;
  let repo: UserRoleRepository;
  let userId: string;
  let roleId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new UserRoleRepository(db);
    const userRepo = new UserRepository(db);
    const roleRepo = new RoleRepository(db);
    const u = await userRepo.create({
      email: 'ur@x.test', name: 'UR', login: 'ur', orgId: 'org_main',
    });
    const r = await roleRepo.create({ orgId: 'org_main', name: 'fixed:ur', uid: 'fixed_ur' });
    userId = u.id;
    roleId = r.id;
  });

  it('create() associates user + role', async () => {
    const ur = await repo.create({ orgId: 'org_main', userId, roleId });
    expect(ur.userId).toBe(userId);
  });

  it('findById() returns the row', async () => {
    const ur = await repo.create({ orgId: 'org_main', userId, roleId });
    expect((await repo.findById(ur.id))!.id).toBe(ur.id);
  });

  it('listByUser() returns assignments for a user', async () => {
    await repo.create({ orgId: 'org_main', userId, roleId });
    expect(await repo.listByUser(userId)).toHaveLength(1);
  });

  it('listByUser() with org filter includes global roles (orgId="")', async () => {
    const roleRepo = new RoleRepository(db);
    const globalRole = await roleRepo.create({ orgId: '', name: 'global-r', uid: 'global_r' });
    await repo.create({ orgId: 'org_main', userId, roleId });
    await repo.create({ orgId: '', userId, roleId: globalRole.id });
    expect(await repo.listByUser(userId, 'org_main')).toHaveLength(2);
  });

  it('listByRole() returns assignments for a role', async () => {
    await repo.create({ orgId: 'org_main', userId, roleId });
    expect(await repo.listByRole(roleId)).toHaveLength(1);
  });

  it('delete() removes a single row', async () => {
    const ur = await repo.create({ orgId: 'org_main', userId, roleId });
    expect(await repo.delete(ur.id)).toBe(true);
  });

  it('remove() deletes by (org, user, role)', async () => {
    await repo.create({ orgId: 'org_main', userId, roleId });
    expect(await repo.remove('org_main', userId, roleId)).toBe(true);
    expect(await repo.listByUser(userId)).toHaveLength(0);
  });

  it('remove() returns false when no assignment exists', async () => {
    expect(await repo.remove('org_main', userId, roleId)).toBe(false);
  });

  it('unique (org, user, role) rejects duplicates', async () => {
    await repo.create({ orgId: 'org_main', userId, roleId });
    await expect(
      repo.create({ orgId: 'org_main', userId, roleId }),
    ).rejects.toThrow();
  });

  it('cascade deletes assignments when user is deleted', async () => {
    await repo.create({ orgId: 'org_main', userId, roleId });
    const userRepo = new UserRepository(db);
    await userRepo.delete(userId);
    expect(await repo.listByUser(userId)).toHaveLength(0);
  });

  it('cascade deletes assignments when role is deleted', async () => {
    await repo.create({ orgId: 'org_main', userId, roleId });
    const roleRepo = new RoleRepository(db);
    await roleRepo.delete(roleId);
    expect(await repo.listByRole(roleId)).toHaveLength(0);
  });
});
