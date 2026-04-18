/**
 * End-to-end cascade tests for AccessControlService.evaluate — ties together
 * ResourcePermissionService writes + scope resolver + evaluator so the 14
 * scenarios from docs/auth-perm-design/07-resource-permissions.md are
 * exercised against real SQL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  seedDefaultOrg,
  seedRbacForOrg,
  FolderRepository,
  PermissionRepository,
  RoleRepository,
  UserRoleRepository,
  TeamRoleRepository,
  TeamRepository,
  TeamMemberRepository,
  UserRepository,
  OrgUserRepository,
  DashboardAclRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { ac, PermissionLevel, ACTIONS } from '@agentic-obs/common';
import type { Identity } from '@agentic-obs/common';
import { AccessControlService } from './accesscontrol-service.js';
import { DashboardAclService } from './dashboard-acl-service.js';
import { ResourcePermissionService } from './resource-permission-service.js';
import { createResolverRegistry } from '../rbac/resolvers/index.js';

async function buildCtx(db: SqliteClient): Promise<{
  access: AccessControlService;
  perms: ResourcePermissionService;
  folders: FolderRepository;
  teams: TeamRepository;
  teamMembers: TeamMemberRepository;
  users: UserRepository;
  orgUsers: OrgUserRepository;
}> {
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');
  const folders = new FolderRepository(db);
  const teams = new TeamRepository(db);
  const teamMembers = new TeamMemberRepository(db);
  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const legacyAcl = new DashboardAclService({
    dashboardAcl: new DashboardAclRepository(db),
    folders,
    teamMembers,
    db,
  });
  const access = new AccessControlService({
    permissions: new PermissionRepository(db),
    roles: new RoleRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    teamMembers,
    orgUsers,
    legacyAcl,
    resolvers: (orgId) =>
      createResolverRegistry({
        folders,
        orgId,
        dashboardFolderUid: async (oid, uid) => {
          const r = db.all<{ folder_uid: string | null }>(
            sql`SELECT folder_uid FROM dashboards WHERE org_id = ${oid} AND id = ${uid}`,
          );
          return r[0]?.folder_uid ?? null;
        },
      }),
  });
  const perms = new ResourcePermissionService({
    roles: new RoleRepository(db),
    permissions: new PermissionRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    folders,
    users,
    teams,
  });
  return { access, perms, folders, teams, teamMembers, users, orgUsers };
}

function insertDashboard(
  db: SqliteClient,
  id: string,
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
      'org_main', ${folderUid}
    )
  `);
}

describe('AccessControlService.evaluate — folder cascade', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('scenario 1: team Edit on folder → user in team can edit dashboard inside', async () => {
    const { access, perms, folders, teams, teamMembers, users, orgUsers } =
      await buildCtx(db);
    const folder = await folders.create({
      orgId: 'org_main',
      uid: 'fs1',
      title: 'Prod',
    });
    const team = await teams.create({ orgId: 'org_main', name: 'OpsTeam' });
    const u = await users.create({
      email: 'u1@t',
      name: 'U1',
      login: 'u1',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    await teamMembers.create({
      orgId: 'org_main',
      teamId: team.id,
      userId: u.id,
      permission: 0,
    });
    await perms.setBulk('org_main', 'folders', folder.uid, [
      { teamId: team.id, permission: PermissionLevel.Edit },
    ]);
    insertDashboard(db, 'd_s1', folder.uid);
    const identity: Identity = {
      userId: u.id,
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    const allowed = await access.evaluate(
      identity,
      ac.eval(ACTIONS.DashboardsWrite, 'dashboards:uid:d_s1'),
    );
    expect(allowed).toBe(true);
  });

  it('scenario 7: direct Edit on dashboard overrides View from folder', async () => {
    const { access, perms, folders, users, orgUsers } = await buildCtx(db);
    const folder = await folders.create({
      orgId: 'org_main',
      uid: 'fs7',
      title: 'F',
    });
    const u = await users.create({
      email: 'u7@t',
      name: 'U7',
      login: 'u7',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    await perms.setBulk('org_main', 'folders', folder.uid, [
      { userId: u.id, permission: PermissionLevel.View },
    ]);
    insertDashboard(db, 'd_s7', folder.uid);
    await perms.setBulk('org_main', 'dashboards', 'd_s7', [
      { userId: u.id, permission: PermissionLevel.Edit },
    ]);
    const identity: Identity = {
      userId: u.id,
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    const allowed = await access.evaluate(
      identity,
      ac.eval(ACTIONS.DashboardsWrite, 'dashboards:uid:d_s7'),
    );
    expect(allowed).toBe(true);
  });

  it('scenario 5: removing folder grant revokes inherited access', async () => {
    const { access, perms, folders, users, orgUsers } = await buildCtx(db);
    const folder = await folders.create({
      orgId: 'org_main',
      uid: 'fs5',
      title: 'F',
    });
    const u = await users.create({
      email: 'u5@t',
      name: 'U5',
      login: 'u5',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    await perms.setBulk('org_main', 'folders', folder.uid, [
      { userId: u.id, permission: PermissionLevel.Edit },
    ]);
    insertDashboard(db, 'd_s5', folder.uid);
    const makeIdentity = (): Identity => ({
      userId: u.id,
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    });
    let allowed = await access.evaluate(
      makeIdentity(),
      ac.eval(ACTIONS.DashboardsWrite, 'dashboards:uid:d_s5'),
    );
    expect(allowed).toBe(true);
    // Revoke.
    await perms.setBulk('org_main', 'folders', folder.uid, [
      { userId: u.id, permission: null },
    ]);
    // Use a fresh identity object so `permissions` isn't cached from the first call.
    allowed = await access.evaluate(
      makeIdentity(),
      ac.eval(ACTIONS.DashboardsWrite, 'dashboards:uid:d_s5'),
    );
    expect(allowed).toBe(false);
  });

  it('scenario 12: legacy dashboard_acl grant (team Edit) allows user via fallback', async () => {
    const { access, folders, teams, teamMembers, users, orgUsers } =
      await buildCtx(db);
    const team = await teams.create({ orgId: 'org_main', name: 'Legacy' });
    const u = await users.create({
      email: 'u12@t',
      name: 'U12',
      login: 'u12',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: u.id, role: 'Viewer' });
    await teamMembers.create({
      orgId: 'org_main',
      teamId: team.id,
      userId: u.id,
      permission: 0,
    });
    insertDashboard(db, 'd_s12', null);
    const aclRepo = new DashboardAclRepository(db);
    await aclRepo.create({
      orgId: 'org_main',
      dashboardId: 'd_s12',
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
    const allowed = await access.evaluate(
      identity,
      ac.eval(ACTIONS.DashboardsWrite, 'dashboards:uid:d_s12'),
    );
    expect(allowed).toBe(true);
  });

  it('datasource grant is scoped to the specific datasource', async () => {
    const { access, perms, users, orgUsers, teams, teamMembers } =
      await buildCtx(db);
    const team = await teams.create({ orgId: 'org_main', name: 'QueryTeam' });
    const u = await users.create({
      email: 'u10@t',
      name: 'U10',
      login: 'u10',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: u.id, role: 'None' });
    await teamMembers.create({
      orgId: 'org_main',
      teamId: team.id,
      userId: u.id,
      permission: 0,
    });
    await perms.setBulk('org_main', 'datasources', 'prom-prod', [
      { teamId: team.id, permission: PermissionLevel.View },
    ]);
    const identity: Identity = {
      userId: u.id,
      orgId: 'org_main',
      orgRole: 'None',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    expect(
      await access.evaluate(
        identity,
        ac.eval(ACTIONS.DatasourcesQuery, 'datasources:uid:prom-prod'),
      ),
    ).toBe(true);
    // Not the other datasource.
    expect(
      await access.evaluate(
        { ...identity },
        ac.eval(ACTIONS.DatasourcesQuery, 'datasources:uid:prom-staging'),
      ),
    ).toBe(false);
  });
});
