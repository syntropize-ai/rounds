import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { RoleRepository } from './role-repository.js';

describe('RoleRepository', () => {
  let db: SqliteClient;
  let repo: RoleRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new RoleRepository(db);
  });

  it('create() inserts a role with a unique (orgId, uid)', async () => {
    const r = await repo.create({
      orgId: 'org_main', name: 'fixed:dashboards:reader', uid: 'fixed_dashboards_reader',
    });
    expect(r.name).toBe('fixed:dashboards:reader');
    expect(r.version).toBe(0);
  });

  it('findByUid() and findByName() round-trip', async () => {
    const r = await repo.create({
      orgId: 'org_main', name: 'custom:one', uid: 'custom_one',
    });
    expect((await repo.findByUid('org_main', 'custom_one'))!.id).toBe(r.id);
    expect((await repo.findByName('org_main', 'custom:one'))!.id).toBe(r.id);
  });

  it('create() supports global roles (orgId="")', async () => {
    const r = await repo.create({ orgId: '', name: 'basic:server_admin', uid: 'basic_server_admin' });
    expect(r.orgId).toBe('');
  });

  it('list() filters by orgId and can include global roles', async () => {
    await repo.create({ orgId: '', name: 'basic:server_admin', uid: 'bsa' });
    await repo.create({ orgId: 'org_main', name: 'basic:admin', uid: 'ba' });
    const page = await repo.list({ orgId: 'org_main', includeGlobal: true });
    expect(page.items.map((r) => r.name).sort()).toEqual(['basic:admin', 'basic:server_admin']);
  });

  it('list() excludes hidden by default when filter is set', async () => {
    await repo.create({ orgId: 'org_main', name: 'vis', uid: 'vis' });
    await repo.create({ orgId: 'org_main', name: 'hid', uid: 'hid', hidden: true });
    const visible = await repo.list({ orgId: 'org_main', hidden: false });
    expect(visible.items.map((r) => r.name)).toEqual(['vis']);
  });

  it('update() bumps version', async () => {
    const r = await repo.create({ orgId: 'org_main', name: 'x', uid: 'xu' });
    const updated = await repo.update(r.id, { description: 'hello' });
    expect(updated!.description).toBe('hello');
    expect(updated!.version).toBe(1);
  });

  it('delete() removes the row', async () => {
    const r = await repo.create({ orgId: 'org_main', name: 'gone', uid: 'gg' });
    expect(await repo.delete(r.id)).toBe(true);
    expect(await repo.findById(r.id)).toBeNull();
  });

  it('upsertBuiltinRole() is idempotent', async () => {
    const r = await repo.create({ orgId: 'org_main', name: 'basic:viewer', uid: 'bv' });
    const a = await repo.upsertBuiltinRole({ role: 'Viewer', roleId: r.id, orgId: 'org_main' });
    const b = await repo.upsertBuiltinRole({ role: 'Viewer', roleId: r.id, orgId: 'org_main' });
    expect(a.id).toBe(b.id);
  });

  it('listBuiltinRoles() returns mappings for an org', async () => {
    const v = await repo.create({ orgId: 'org_main', name: 'basic:viewer', uid: 'bv' });
    const a = await repo.create({ orgId: 'org_main', name: 'basic:admin', uid: 'ba' });
    await repo.upsertBuiltinRole({ role: 'Viewer', roleId: v.id, orgId: 'org_main' });
    await repo.upsertBuiltinRole({ role: 'Admin', roleId: a.id, orgId: 'org_main' });
    const out = await repo.listBuiltinRoles('org_main');
    expect(out.map((b) => b.role).sort()).toEqual(['Admin', 'Viewer']);
  });

  it('removeBuiltinRole() removes the mapping', async () => {
    const r = await repo.create({ orgId: 'org_main', name: 'basic:editor', uid: 'be' });
    await repo.upsertBuiltinRole({ role: 'Editor', roleId: r.id, orgId: 'org_main' });
    expect(await repo.removeBuiltinRole('Editor', 'org_main', r.id)).toBe(true);
    expect(await repo.listBuiltinRoles('org_main')).toHaveLength(0);
  });

  it('unique (orgId, name) rejects duplicates', async () => {
    await repo.create({ orgId: 'org_main', name: 'dup', uid: 'dup1' });
    await expect(
      repo.create({ orgId: 'org_main', name: 'dup', uid: 'dup2' }),
    ).rejects.toThrow();
  });
});
