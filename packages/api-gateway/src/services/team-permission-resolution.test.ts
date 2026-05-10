/**
 * T5.3 — team permission resolution tests.
 *
 * Focused on the "team_role ∪ user_role ∪ builtin_role" merge performed by
 * AccessControlService.getUserPermissions. The RBAC tests in
 * accesscontrol-service.test.ts already cover the single-team case
 * (scenario 9). This file adds scenario 8 from
 * docs/auth-perm-design/05-teams.md §test-scenarios:
 *   "User in two teams with different roles → union of permissions."
 *
 * Keeping this in team-scoped test file per T5 file scope — the assertion is
 * "team permission resolution works" which is firmly a teams concern.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDb,
  seedDefaultOrg,
  seedRbacForOrg,
  UserRepository,
  OrgUserRepository,
  TeamRepository,
  TeamMemberRepository,
  RoleRepository,
  PermissionRepository,
  UserRoleRepository,
  TeamRoleRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { ac } from '@agentic-obs/common';
import { AccessControlService } from './accesscontrol-service.js';

async function buildSvc(db: SqliteClient) {
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');
  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const teams = new TeamRepository(db);
  const teamMembers = new TeamMemberRepository(db);
  const roles = new RoleRepository(db);
  const permissions = new PermissionRepository(db);
  const userRoles = new UserRoleRepository(db);
  const teamRoles = new TeamRoleRepository(db);
  const service = new AccessControlService({
    permissions,
    roles,
    userRoles,
    teamRoles,
    teamMembers,
    orgUsers,
  });
  return {
    users,
    teams,
    teamMembers,
    roles,
    permissions,
    teamRoles,
    service,
  };
}

describe('AccessControlService — team permission resolution (T5.3)', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('user in two teams with different roles gets the union of permissions', async () => {
    // Scenario 8 from 05-teams.md.
    const h = await buildSvc(db);
    const user = await h.users.create({
      email: 'union@x.y',
      name: 'U',
      login: 'u_union',
      orgId: 'org_main',
    });

    const team1 = await h.teams.create({ orgId: 'org_main', name: 'Team1' });
    const team2 = await h.teams.create({ orgId: 'org_main', name: 'Team2' });
    await h.teamMembers.create({
      orgId: 'org_main',
      teamId: team1.id,
      userId: user.id,
    });
    await h.teamMembers.create({
      orgId: 'org_main',
      teamId: team2.id,
      userId: user.id,
    });

    // Team1 → can read dashboards.
    const role1 = await h.roles.create({
      orgId: 'org_main',
      name: 'custom:team1',
      uid: 'custom_team1',
    });
    await h.permissions.create({
      roleId: role1.id,
      action: 'dashboards:read',
      scope: 'dashboards:*',
    });
    await h.teamRoles.create({
      orgId: 'org_main',
      teamId: team1.id,
      roleId: role1.id,
    });

    // Team2 → can read datasources.
    const role2 = await h.roles.create({
      orgId: 'org_main',
      name: 'custom:team2',
      uid: 'custom_team2',
    });
    await h.permissions.create({
      roleId: role2.id,
      action: 'connectors:read',
      scope: 'connectors:*',
    });
    await h.teamRoles.create({
      orgId: 'org_main',
      teamId: team2.id,
      roleId: role2.id,
    });

    const identity = {
      userId: user.id,
      orgId: 'org_main',
      orgRole: 'None' as const,
      isServerAdmin: false,
      authenticatedBy: 'session' as const,
    };

    expect(
      await h.service.evaluate(
        identity,
        ac.eval('dashboards:read', 'dashboards:uid:any'),
      ),
    ).toBe(true);
    expect(
      await h.service.evaluate(
        identity,
        ac.eval('connectors:read', 'connectors:uid:any'),
      ),
    ).toBe(true);
    // A permission neither team carries → denied (no inheritance from elsewhere).
    expect(
      await h.service.evaluate(identity, ac.eval('teams:create')),
    ).toBe(false);
  });

  it('removing a user from a team strips that team role (no stale cache)', async () => {
    const h = await buildSvc(db);
    const user = await h.users.create({
      email: 'evict@x.y',
      name: 'E',
      login: 'u_evict',
      orgId: 'org_main',
    });
    const team = await h.teams.create({ orgId: 'org_main', name: 'Evict' });
    await h.teamMembers.create({
      orgId: 'org_main',
      teamId: team.id,
      userId: user.id,
    });
    const role = await h.roles.create({
      orgId: 'org_main',
      name: 'custom:evictable',
      uid: 'custom_evictable',
    });
    await h.permissions.create({
      roleId: role.id,
      action: 'alert.rules:read',
      scope: 'alert.rules:*',
    });
    await h.teamRoles.create({
      orgId: 'org_main',
      teamId: team.id,
      roleId: role.id,
    });

    const base = {
      userId: user.id,
      orgId: 'org_main',
      orgRole: 'None' as const,
      isServerAdmin: false,
      authenticatedBy: 'session' as const,
    };
    // Before eviction.
    expect(
      await h.service.evaluate(
        { ...base },
        ac.eval('alert.rules:read', 'alert.rules:uid:any'),
      ),
    ).toBe(true);

    // Evict and re-check with a fresh identity (no per-request cache).
    await h.teamMembers.remove(team.id, user.id);

    expect(
      await h.service.evaluate(
        { ...base },
        ac.eval('alert.rules:read', 'alert.rules:uid:any'),
      ),
    ).toBe(false);
  });

  it('team_role from another org is not applied to a user outside that org', async () => {
    const h = await buildSvc(db);
    // Create second org.
    const orgsModule = await import('@agentic-obs/data-layer');
    const OrgRepo = orgsModule.OrgRepository;
    const other = await new OrgRepo(db).create({ name: 'OtherOrg' });
    await seedRbacForOrg(db, other.id);

    const user = await h.users.create({
      email: 'x-org@x.y',
      name: 'X',
      login: 'x_org',
      orgId: 'org_main',
    });
    // Team in other org.
    const team = await h.teams.create({
      orgId: other.id,
      name: 'OtherTeam',
    });
    await h.teamMembers.create({
      orgId: other.id,
      teamId: team.id,
      userId: user.id,
    });
    const role = await h.roles.create({
      orgId: other.id,
      name: 'custom:other',
      uid: 'custom_other',
    });
    await h.permissions.create({
      roleId: role.id,
      action: 'folders:read',
      scope: 'folders:*',
    });
    await h.teamRoles.create({
      orgId: other.id,
      teamId: team.id,
      roleId: role.id,
    });

    // When evaluating in org_main, the other-org team's role should not be
    // inherited.
    const id = {
      userId: user.id,
      orgId: 'org_main',
      orgRole: 'None' as const,
      isServerAdmin: false,
      authenticatedBy: 'session' as const,
    };
    expect(
      await h.service.evaluate(id, ac.eval('folders:read', 'folders:uid:any')),
    ).toBe(false);
  });
});
