/**
 * ResourcePermissionService unit tests (T7.2).
 *
 * Exercises grants for users, teams, and built-in roles across folders,
 * dashboards, datasources, and alert rules. Verifies:
 *   - managed-role naming convention (managed:<kind>:<id>:permissions)
 *   - action mapping (View/Edit/Admin per resource)
 *   - cascade from ancestor folders
 *   - higher direct permission overrides inherited
 *   - removal when permission=null
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDb,
  seedDefaultOrg,
  FolderRepository,
  RoleRepository,
  PermissionRepository,
  UserRoleRepository,
  TeamRoleRepository,
  TeamRepository,
  UserRepository,
  OrgUserRepository,
  seedRbacForOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { PermissionLevel } from '@agentic-obs/common';
import { ResourcePermissionService } from './resource-permission-service.js';

async function makeCtx(db: SqliteClient): Promise<{
  svc: ResourcePermissionService;
  folders: FolderRepository;
  teams: TeamRepository;
  users: UserRepository;
  orgUsers: OrgUserRepository;
}> {
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');
  const folders = new FolderRepository(db);
  const teams = new TeamRepository(db);
  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const svc = new ResourcePermissionService({
    roles: new RoleRepository(db),
    permissions: new PermissionRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    folders,
    users,
    teams,
  });
  return { svc, folders, teams, users, orgUsers };
}

async function seedUser(
  users: UserRepository,
  orgUsers: OrgUserRepository,
  login: string,
  role: 'Admin' | 'Editor' | 'Viewer' = 'Viewer',
): Promise<string> {
  const u = await users.create({
    email: `${login}@test`,
    name: login,
    login,
    orgId: 'org_main',
  });
  await orgUsers.create({ orgId: 'org_main', userId: u.id, role });
  return u.id;
}

describe('ResourcePermissionService — folders', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('grants View to a user on a folder', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'f1',
      title: 'F1',
    });
    const userId = await seedUser(users, orgUsers, 'alice');
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.View },
    ]);
    const entries = await svc.list('org_main', 'folders', f.uid);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe(userId);
    expect(entries[0]!.permission).toBe(PermissionLevel.View);
    expect(entries[0]!.actions).toContain('folders:read');
  });

  it('Edit level on a folder includes dashboards:create inside folder', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'f2',
      title: 'F2',
    });
    const userId = await seedUser(users, orgUsers, 'bob');
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.Edit },
    ]);
    const entries = await svc.list('org_main', 'folders', f.uid);
    expect(entries[0]!.permission).toBe(PermissionLevel.Edit);
    expect(entries[0]!.actions).toEqual(
      expect.arrayContaining(['folders:read', 'folders:write', 'folders:delete', 'dashboards:create']),
    );
  });

  it('Admin level adds permissions:* actions', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'f3',
      title: 'F3',
    });
    const userId = await seedUser(users, orgUsers, 'carol');
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.Admin },
    ]);
    const entries = await svc.list('org_main', 'folders', f.uid);
    expect(entries[0]!.permission).toBe(PermissionLevel.Admin);
    expect(entries[0]!.actions).toEqual(
      expect.arrayContaining([
        'folders.permissions:read',
        'folders.permissions:write',
      ]),
    );
  });

  it('grants team + built-in role simultaneously on same folder', async () => {
    const { svc, folders, teams } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'f4',
      title: 'F4',
    });
    const team = await teams.create({ orgId: 'org_main', name: 'Team A' });
    await svc.setBulk('org_main', 'folders', f.uid, [
      { teamId: team.id, permission: PermissionLevel.Edit },
      { role: 'Viewer', permission: PermissionLevel.View },
    ]);
    const entries = await svc.list('org_main', 'folders', f.uid);
    expect(entries.some((e) => e.teamId === team.id)).toBe(true);
    expect(entries.some((e) => e.builtInRole === 'Viewer')).toBe(true);
  });

  it('removes grant when permission=null', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'f5',
      title: 'F5',
    });
    const userId = await seedUser(users, orgUsers, 'dan');
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.Edit },
    ]);
    expect(await svc.list('org_main', 'folders', f.uid)).toHaveLength(1);
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: null },
    ]);
    expect(await svc.list('org_main', 'folders', f.uid)).toHaveLength(0);
  });

  it('rejects bad input: multiple principal fields set', async () => {
    const { svc, folders } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'f6',
      title: 'F6',
    });
    await expect(
      svc.setBulk('org_main', 'folders', f.uid, [
        { userId: 'u', teamId: 't', permission: PermissionLevel.View },
      ]),
    ).rejects.toThrow(/exactly one/);
  });

  it('second grant re-uses the same managed role (role per user, not per resource)', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f1 = await folders.create({
      orgId: 'org_main',
      uid: 'f7a',
      title: 'F7a',
    });
    const f2 = await folders.create({
      orgId: 'org_main',
      uid: 'f7b',
      title: 'F7b',
    });
    const userId = await seedUser(users, orgUsers, 'eve');
    await svc.setBulk('org_main', 'folders', f1.uid, [
      { userId, permission: PermissionLevel.Edit },
    ]);
    await svc.setBulk('org_main', 'folders', f2.uid, [
      { userId, permission: PermissionLevel.View },
    ]);
    // Both entries reference the same role name.
    const e1 = await svc.list('org_main', 'folders', f1.uid);
    const e2 = await svc.list('org_main', 'folders', f2.uid);
    expect(e1[0]!.roleName).toBe(e2[0]!.roleName);
    expect(e1[0]!.roleName).toBe(`managed:users:${userId}:permissions`);
  });
});

describe('ResourcePermissionService — cascade for dashboards', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('lists dashboard permissions inherited from folder', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'fc1',
      title: 'Folder',
    });
    const userId = await seedUser(users, orgUsers, 'frank');
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.Edit },
    ]);
    // Query dashboard-level permissions for a dash inside the folder.
    const entries = await svc.list('org_main', 'dashboards', 'dash_1', {
      dashboardFolderUid: f.uid,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isInherited).toBe(true);
    expect(entries[0]!.inheritedFrom?.uid).toBe(f.uid);
  });

  it('cascade walks through nested ancestor folders', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const root = await folders.create({
      orgId: 'org_main',
      uid: 'root',
      title: 'Root',
    });
    const sub = await folders.create({
      orgId: 'org_main',
      uid: 'sub',
      title: 'Sub',
      parentUid: root.uid,
    });
    const userId = await seedUser(users, orgUsers, 'gwen');
    await svc.setBulk('org_main', 'folders', root.uid, [
      { userId, permission: PermissionLevel.View },
    ]);
    const entries = await svc.list('org_main', 'dashboards', 'dash_2', {
      dashboardFolderUid: sub.uid,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.inheritedFrom?.uid).toBe(root.uid);
  });

  it('direct dashboard permission wins over inherited (same principal)', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'fc2',
      title: 'Folder',
    });
    const userId = await seedUser(users, orgUsers, 'hank');
    // View on the folder.
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.View },
    ]);
    // Edit directly on the dashboard.
    await svc.setBulk('org_main', 'dashboards', 'dash_3', [
      { userId, permission: PermissionLevel.Edit },
    ]);
    const entries = await svc.list('org_main', 'dashboards', 'dash_3', {
      dashboardFolderUid: f.uid,
    });
    const mine = entries.find((e) => e.userId === userId)!;
    // Direct grant should survive as the authoritative row — isInherited=false.
    expect(mine.isInherited).toBe(false);
    // And the level should be the merged/highest value (Edit).
    expect(mine.permission).toBe(PermissionLevel.Edit);
  });
});

describe('ResourcePermissionService — datasources + alert.rules', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('datasource View expands to datasources:query', async () => {
    const { svc, users, orgUsers } = await makeCtx(db);
    const userId = await seedUser(users, orgUsers, 'ida');
    await svc.setBulk('org_main', 'datasources', 'prom-prod', [
      { userId, permission: PermissionLevel.View },
    ]);
    const entries = await svc.list('org_main', 'datasources', 'prom-prod');
    expect(entries[0]!.actions).toContain('datasources:query');
  });

  it('datasources have no folder cascade', async () => {
    const { svc, users, orgUsers, folders } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'fx',
      title: 'X',
    });
    const userId = await seedUser(users, orgUsers, 'jack');
    await svc.setBulk('org_main', 'folders', f.uid, [
      { userId, permission: PermissionLevel.Admin },
    ]);
    // Datasource grants are flat — folder perms do not cascade in the list.
    const entries = await svc.list('org_main', 'datasources', 'some-ds');
    expect(entries).toHaveLength(0);
  });

  it('alert.rules are scoped to the folder UID', async () => {
    const { svc, folders, users, orgUsers } = await makeCtx(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'fa',
      title: 'Alerts',
    });
    const userId = await seedUser(users, orgUsers, 'kira');
    await svc.setBulk('org_main', 'alert.rules', f.uid, [
      { userId, permission: PermissionLevel.Edit },
    ]);
    const entries = await svc.list('org_main', 'alert.rules', f.uid);
    expect(entries[0]!.actions).toEqual(
      expect.arrayContaining(['alert.rules:read', 'alert.rules:write', 'alert.rules:create', 'alert.rules:delete']),
    );
  });
});
