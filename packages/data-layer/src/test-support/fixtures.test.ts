import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-db.js';
import {
  makeOrg,
  makeUser,
  makeServiceAccount,
  makeOrgUser,
  makeTeam,
  makeTeamMember,
  makeApiKey,
  makeRole,
  makePermission,
  makeFolder,
  makeAuditLog,
  seedDefaultOrg,
  seedServerAdmin,
  seedBuiltinRoles,
  OrgUserRepository,
  RoleRepository,
} from './fixtures.js';

describe('fixture builders', () => {
  it('makeOrg() returns a valid Org', () => {
    const o = makeOrg({ name: 'Custom' });
    expect(o.name).toBe('Custom');
    expect(o.id).toBeTruthy();
  });

  it('makeUser() defaults are sensible', () => {
    const u = makeUser();
    expect(u.isAdmin).toBe(false);
    expect(u.isServiceAccount).toBe(false);
    expect(u.orgId).toBe('org_main');
  });

  it('makeServiceAccount() flips isServiceAccount', () => {
    const sa = makeServiceAccount('org_main');
    expect(sa.isServiceAccount).toBe(true);
  });

  it('makeOrgUser() captures role', () => {
    const ou = makeOrgUser('org_main', 'u1', 'Editor');
    expect(ou.role).toBe('Editor');
  });

  it('makeTeam + makeTeamMember produce correct shape', () => {
    const t = makeTeam('org_main');
    const tm = makeTeamMember('org_main', t.id, 'u1');
    expect(tm.teamId).toBe(t.id);
    expect(tm.userId).toBe('u1');
    expect(tm.permission).toBe(0);
  });

  it('makeApiKey() defaults to personal access token', () => {
    const k = makeApiKey('org_main');
    expect(k.serviceAccountId).toBeNull();
  });

  it('makeRole + makePermission parse scope', () => {
    const r = makeRole('org_main');
    const p = makePermission(r.id, 'dashboards:read', 'dashboards:uid:abc');
    expect(p.kind).toBe('dashboards');
    expect(p.attribute).toBe('uid');
    expect(p.identifier).toBe('abc');
  });

  it('makeFolder() default parentUid is null', () => {
    const f = makeFolder('org_main');
    expect(f.parentUid).toBeNull();
  });

  it('makeAuditLog() default outcome is success', () => {
    const a = makeAuditLog();
    expect(a.outcome).toBe('success');
  });
});

describe('seeders', () => {
  it('seedDefaultOrg() returns org_main', async () => {
    const db = createTestDb();
    const org = await seedDefaultOrg(db);
    expect(org.id).toBe('org_main');
  });

  it('seedServerAdmin() creates user + Admin org_user', async () => {
    const db = createTestDb();
    const { user, orgUser } = await seedServerAdmin(db, {
      email: 'root@example.test', login: 'root',
    });
    expect(user.isAdmin).toBe(true);
    expect(orgUser.role).toBe('Admin');
    // Idempotent — second call doesn't dup.
    await seedServerAdmin(db, { email: 'root@example.test', login: 'root' });
    const ouRepo = new OrgUserRepository(db);
    expect((await ouRepo.listOrgsByUser(user.id))).toHaveLength(1);
  });

  it('seedBuiltinRoles() creates 4 role rows + builtin mappings', async () => {
    const db = createTestDb();
    await seedDefaultOrg(db);
    const { viewerRole, editorRole, adminRole, serverAdminRole } = await seedBuiltinRoles(
      db, 'org_main',
    );
    expect(viewerRole.name).toBe('basic:viewer');
    expect(editorRole.name).toBe('basic:editor');
    expect(adminRole.name).toBe('basic:admin');
    expect(serverAdminRole.orgId).toBe(''); // global
    const roleRepo = new RoleRepository(db);
    const mappings = await roleRepo.listBuiltinRoles('org_main');
    expect(mappings.map((m) => m.role).sort()).toEqual(['Admin', 'Editor', 'Viewer']);
  });

  it('seedBuiltinRoles() is idempotent', async () => {
    const db = createTestDb();
    await seedDefaultOrg(db);
    await seedBuiltinRoles(db, 'org_main');
    await seedBuiltinRoles(db, 'org_main');
    const roleRepo = new RoleRepository(db);
    expect((await roleRepo.listBuiltinRoles('org_main'))).toHaveLength(3);
  });

  it('seedBuiltinRoles() does NOT populate permission rows (T3.1 responsibility)', async () => {
    const db = createTestDb();
    await seedDefaultOrg(db);
    const { viewerRole } = await seedBuiltinRoles(db, 'org_main');
    const { PermissionRepository } = await import('../repository/auth/permission-repository.js');
    const permRepo = new PermissionRepository(db);
    expect(await permRepo.listByRole(viewerRole.id)).toHaveLength(0);
  });
});
