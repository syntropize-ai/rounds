/**
 * DashboardAclService unit tests (T7.6).
 *
 * Covers legacy `dashboard_acl` read paths — including folder-cascade lookup
 * and the `grantsAtLeast` helper consumed by AccessControlService fallback.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  seedDefaultOrg,
  DashboardAclRepository,
  FolderRepository,
  TeamRepository,
  TeamMemberRepository,
  UserRepository,
  OrgUserRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { DashboardAclService } from './dashboard-acl-service.js';

function makeSvc(db: SqliteClient): DashboardAclService {
  return new DashboardAclService({
    dashboardAcl: new DashboardAclRepository(db),
    folders: new FolderRepository(db),
    teamMembers: new TeamMemberRepository(db),
    db,
  });
}

function insertDashboard(
  db: SqliteClient,
  id: string,
  orgId: string,
  folderUid: string | null,
): void {
  db.run(sql`
    INSERT INTO dashboards (
      id, type, title, description, prompt, user_id, status,
      panels, variables, refresh_interval_sec, datasource_ids,
      use_existing_metrics, created_at, updated_at, org_id, folder_uid
    ) VALUES (
      ${id}, 'dashboard', 'T', '', '', 'u', 'ready',
      '[]', '[]', 30, '[]', 1,
      '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
      ${orgId}, ${folderUid}
    )
  `);
}

describe('DashboardAclService.getForDashboard', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await seedDefaultOrg(db);
  });

  it('reads a direct ACL row', async () => {
    const svc = makeSvc(db);
    insertDashboard(db, 'dash_a', 'org_main', null);
    const acl = new DashboardAclRepository(db);
    await acl.create({
      orgId: 'org_main',
      dashboardId: 'dash_a',
      userId: 'user_x',
      permission: 2,
    });
    const entries = await svc.getForDashboard('org_main', 'dash_a');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isInherited).toBe(false);
    expect(entries[0]!.permission).toBe(2);
  });

  it('reads inherited rows from the folder', async () => {
    const svc = makeSvc(db);
    const folders = new FolderRepository(db);
    const folder = await folders.create({
      orgId: 'org_main',
      uid: 'f_leg',
      title: 'Legacy',
    });
    insertDashboard(db, 'dash_b', 'org_main', folder.uid);
    const acl = new DashboardAclRepository(db);
    await acl.create({
      orgId: 'org_main',
      folderId: folder.id,
      teamId: 'team_1',
      permission: 4,
    });
    const entries = await svc.getForDashboard('org_main', 'dash_b');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isInherited).toBe(true);
    expect(entries[0]!.inheritedFrom).toBe(folder.uid);
  });

  it('walks ancestor folders', async () => {
    const svc = makeSvc(db);
    const folders = new FolderRepository(db);
    const root = await folders.create({
      orgId: 'org_main',
      uid: 'root_leg',
      title: 'R',
    });
    const sub = await folders.create({
      orgId: 'org_main',
      uid: 'sub_leg',
      title: 'S',
      parentUid: root.uid,
    });
    insertDashboard(db, 'dash_c', 'org_main', sub.uid);
    const acl = new DashboardAclRepository(db);
    await acl.create({
      orgId: 'org_main',
      folderId: root.id,
      role: 'Viewer',
      permission: 1,
    });
    const entries = await svc.getForDashboard('org_main', 'dash_c');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.inheritedFrom).toBe(root.uid);
  });
});

describe('DashboardAclService.grantsAtLeast', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await seedDefaultOrg(db);
  });

  it('returns true when direct user ACL meets the required level', async () => {
    const svc = makeSvc(db);
    insertDashboard(db, 'dash_d', 'org_main', null);
    const acl = new DashboardAclRepository(db);
    await acl.create({
      orgId: 'org_main',
      dashboardId: 'dash_d',
      userId: 'user_a',
      permission: 2,
    });
    const identity: Identity = {
      userId: 'user_a',
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    expect(await svc.grantsAtLeast('org_main', 'dash_d', identity, 1)).toBe(true);
    expect(await svc.grantsAtLeast('org_main', 'dash_d', identity, 2)).toBe(true);
    expect(await svc.grantsAtLeast('org_main', 'dash_d', identity, 4)).toBe(false);
  });

  it('resolves team-scoped ACL via TeamMemberRepository', async () => {
    const svc = makeSvc(db);
    insertDashboard(db, 'dash_e', 'org_main', null);
    const teams = new TeamRepository(db);
    const team = await teams.create({ orgId: 'org_main', name: 'Ops' });
    const users = new UserRepository(db);
    const u = await users.create({
      email: 'op@test',
      name: 'Op',
      login: 'op',
      orgId: 'org_main',
    });
    const tm = new TeamMemberRepository(db);
    await tm.create({
      orgId: 'org_main',
      teamId: team.id,
      userId: u.id,
      permission: 0,
    });
    const acl = new DashboardAclRepository(db);
    await acl.create({
      orgId: 'org_main',
      dashboardId: 'dash_e',
      teamId: team.id,
      permission: 2,
    });
    const identity: Identity = {
      userId: u.id,
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    expect(await svc.grantsAtLeast('org_main', 'dash_e', identity, 2)).toBe(true);
  });

  it('resolves role-scoped ACL against identity.orgRole', async () => {
    const svc = makeSvc(db);
    insertDashboard(db, 'dash_f', 'org_main', null);
    const acl = new DashboardAclRepository(db);
    await acl.create({
      orgId: 'org_main',
      dashboardId: 'dash_f',
      role: 'Editor',
      permission: 2,
    });
    const editorIdentity: Identity = {
      userId: 'user_z',
      orgId: 'org_main',
      orgRole: 'Editor',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    expect(await svc.grantsAtLeast('org_main', 'dash_f', editorIdentity, 2)).toBe(
      true,
    );
    const viewerIdentity: Identity = { ...editorIdentity, orgRole: 'Viewer' };
    expect(await svc.grantsAtLeast('org_main', 'dash_f', viewerIdentity, 2)).toBe(
      false,
    );
  });

  it('returns false when no ACL rows exist', async () => {
    const svc = makeSvc(db);
    insertDashboard(db, 'dash_g', 'org_main', null);
    const identity: Identity = {
      userId: 'user_q',
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    expect(await svc.grantsAtLeast('org_main', 'dash_g', identity, 1)).toBe(false);
  });
});
