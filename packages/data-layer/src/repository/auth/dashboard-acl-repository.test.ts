import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { DashboardAclRepository } from './dashboard-acl-repository.js';
import {
  DASHBOARD_PERMISSION_VIEW,
  DASHBOARD_PERMISSION_EDIT,
  DASHBOARD_PERMISSION_ADMIN,
} from '@agentic-obs/common';

describe('DashboardAclRepository', () => {
  let db: SqliteClient;
  let repo: DashboardAclRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new DashboardAclRepository(db);
  });

  it('create() with userId as principal', async () => {
    const a = await repo.create({
      orgId: 'org_main', dashboardId: 'dash_1', userId: 'user_1',
      permission: DASHBOARD_PERMISSION_VIEW,
    });
    expect(a.userId).toBe('user_1');
    expect(a.permission).toBe(DASHBOARD_PERMISSION_VIEW);
  });

  it('create() with teamId as principal', async () => {
    const a = await repo.create({
      orgId: 'org_main', dashboardId: 'dash_1', teamId: 'team_1',
      permission: DASHBOARD_PERMISSION_EDIT,
    });
    expect(a.teamId).toBe('team_1');
  });

  it('create() with role as principal', async () => {
    const a = await repo.create({
      orgId: 'org_main', folderId: 'folder_1', role: 'Viewer',
      permission: DASHBOARD_PERMISSION_VIEW,
    });
    expect(a.role).toBe('Viewer');
  });

  it('create() rejects rows with no principal', async () => {
    await expect(
      repo.create({
        orgId: 'org_main', dashboardId: 'd', permission: DASHBOARD_PERMISSION_VIEW,
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('create() rejects rows with two principals', async () => {
    await expect(
      repo.create({
        orgId: 'org_main', dashboardId: 'd', userId: 'u', teamId: 't',
        permission: DASHBOARD_PERMISSION_VIEW,
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('create() requires dashboardId OR folderId', async () => {
    await expect(
      repo.create({
        orgId: 'org_main', userId: 'u', permission: DASHBOARD_PERMISSION_VIEW,
      }),
    ).rejects.toThrow(/dashboardId.*folderId/);
  });

  it('create() rejects both dashboardId and folderId', async () => {
    await expect(
      repo.create({
        orgId: 'org_main', dashboardId: 'd', folderId: 'f', userId: 'u',
        permission: DASHBOARD_PERMISSION_VIEW,
      }),
    ).rejects.toThrow(/either/);
  });

  it('listByDashboard() returns ACL rows', async () => {
    await repo.create({
      orgId: 'org_main', dashboardId: 'd', userId: 'u1', permission: DASHBOARD_PERMISSION_VIEW,
    });
    await repo.create({
      orgId: 'org_main', dashboardId: 'd', userId: 'u2', permission: DASHBOARD_PERMISSION_EDIT,
    });
    expect(await repo.listByDashboard('d')).toHaveLength(2);
  });

  it('listByFolder() returns ACL rows', async () => {
    await repo.create({
      orgId: 'org_main', folderId: 'f', teamId: 't', permission: DASHBOARD_PERMISSION_ADMIN,
    });
    expect(await repo.listByFolder('f')).toHaveLength(1);
  });

  it('listByUser() and listByTeam() filter appropriately', async () => {
    await repo.create({
      orgId: 'org_main', dashboardId: 'd', userId: 'u', permission: DASHBOARD_PERMISSION_VIEW,
    });
    await repo.create({
      orgId: 'org_main', dashboardId: 'd', teamId: 't', permission: DASHBOARD_PERMISSION_EDIT,
    });
    expect(await repo.listByUser('org_main', 'u')).toHaveLength(1);
    expect(await repo.listByTeam('org_main', 't')).toHaveLength(1);
  });

  it('delete() removes the row', async () => {
    const a = await repo.create({
      orgId: 'org_main', dashboardId: 'd', userId: 'u', permission: DASHBOARD_PERMISSION_VIEW,
    });
    expect(await repo.delete(a.id)).toBe(true);
  });

  it('deleteByDashboard() removes every row for a dashboard', async () => {
    await repo.create({
      orgId: 'org_main', dashboardId: 'd', userId: 'u1', permission: DASHBOARD_PERMISSION_VIEW,
    });
    await repo.create({
      orgId: 'org_main', dashboardId: 'd', userId: 'u2', permission: DASHBOARD_PERMISSION_VIEW,
    });
    expect(await repo.deleteByDashboard('d')).toBe(2);
  });

  it('deleteByFolder() removes every row for a folder', async () => {
    await repo.create({
      orgId: 'org_main', folderId: 'f', userId: 'u', permission: DASHBOARD_PERMISSION_VIEW,
    });
    expect(await repo.deleteByFolder('f')).toBe(1);
  });
});
