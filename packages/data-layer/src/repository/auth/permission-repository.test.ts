import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { PermissionRepository } from './permission-repository.js';
import { RoleRepository } from './role-repository.js';

describe('PermissionRepository', () => {
  let db: SqliteClient;
  let repo: PermissionRepository;
  let roleId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new PermissionRepository(db);
    const roleRepo = new RoleRepository(db);
    const r = await roleRepo.create({ orgId: 'org_main', name: 'perm-test', uid: 'perm_test' });
    roleId = r.id;
  });

  it('create() parses scope into kind / attribute / identifier', async () => {
    const p = await repo.create({ roleId, action: 'dashboards:read', scope: 'dashboards:uid:abc' });
    expect(p.kind).toBe('dashboards');
    expect(p.attribute).toBe('uid');
    expect(p.identifier).toBe('abc');
  });

  it('create() treats empty scope as ("*","*","*")', async () => {
    const p = await repo.create({ roleId, action: 'orgs:read' });
    expect(p.scope).toBe('');
    expect(p.kind).toBe('*');
    expect(p.attribute).toBe('*');
    expect(p.identifier).toBe('*');
  });

  it('create() with wildcard scope retains the wildcard literals', async () => {
    const p = await repo.create({ roleId, action: 'dashboards:write', scope: 'dashboards:*' });
    expect(p.kind).toBe('dashboards');
    expect(p.attribute).toBe('*');
    expect(p.identifier).toBe('*');
  });

  it('createMany() inserts all rows', async () => {
    const batch = await repo.createMany([
      { roleId, action: 'dashboards:read', scope: 'dashboards:*' },
      { roleId, action: 'folders:read', scope: 'folders:*' },
    ]);
    expect(batch).toHaveLength(2);
  });

  it('listByRole() returns permissions for a role', async () => {
    await repo.create({ roleId, action: 'a:read' });
    await repo.create({ roleId, action: 'b:read' });
    expect(await repo.listByRole(roleId)).toHaveLength(2);
  });

  it('listByRoles() fetches for multiple roles', async () => {
    const roleRepo = new RoleRepository(db);
    const r2 = await roleRepo.create({ orgId: 'org_main', name: 'perm-test-2', uid: 'pt2' });
    await repo.create({ roleId, action: 'a:read' });
    await repo.create({ roleId: r2.id, action: 'b:read' });
    const out = await repo.listByRoles([roleId, r2.id]);
    expect(out).toHaveLength(2);
  });

  it('listByAction() returns every row with that action', async () => {
    await repo.create({ roleId, action: 'dashboards:read' });
    await repo.create({ roleId, action: 'dashboards:read', scope: 'dashboards:uid:1' });
    expect(await repo.listByAction('dashboards:read')).toHaveLength(2);
  });

  it('deleteByRole() removes all rows for that role', async () => {
    await repo.create({ roleId, action: 'a' });
    await repo.create({ roleId, action: 'b' });
    expect(await repo.deleteByRole(roleId)).toBe(2);
  });

  it('delete() removes a single row', async () => {
    const p = await repo.create({ roleId, action: 'x' });
    expect(await repo.delete(p.id)).toBe(true);
  });

  it('cascade deletes permissions when role is deleted', async () => {
    await repo.create({ roleId, action: 'a:read' });
    const roleRepo = new RoleRepository(db);
    await roleRepo.delete(roleId);
    expect(await repo.listByRole(roleId)).toHaveLength(0);
  });
});
