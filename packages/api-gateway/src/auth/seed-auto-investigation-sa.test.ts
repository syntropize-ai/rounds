import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDb,
  seedDefaultOrg,
  seedRbacForOrg,
  UserRepository,
  OrgUserRepository,
  RoleRepository,
  PermissionRepository,
  UserRoleRepository,
  TeamRoleRepository,
  type SqliteClient,
} from '@agentic-obs/data-layer';
import { RoleService } from '../services/role-service.js';
import {
  seedAutoInvestigationSaIfNeeded,
  AUTO_INVESTIGATION_SA_LOGIN,
  AUTO_INVESTIGATION_SA_EMAIL,
} from './seed-auto-investigation-sa.js';

// We assert by role.name (the `fixed:ops.commands:runner` form) — it's
// stable and easier to grep for than the uid (`fixed_ops_commands_runner`).
const OPS_COMMANDS_RUNNER_ROLE_NAME = 'fixed:ops.commands:runner';

describe('seedAutoInvestigationSaIfNeeded', () => {
  let db: SqliteClient;
  let users: UserRepository;
  let orgUsers: OrgUserRepository;
  let roles: RoleService;
  let userRolesRepo: UserRoleRepository;
  let rolesRepo: RoleRepository;

  beforeEach(async () => {
    db = createTestDb();
    await seedDefaultOrg(db);
    await seedRbacForOrg(db, 'org_main');
    users = new UserRepository(db);
    orgUsers = new OrgUserRepository(db);
    rolesRepo = new RoleRepository(db);
    const permissionsRepo = new PermissionRepository(db);
    userRolesRepo = new UserRoleRepository(db);
    const teamRolesRepo = new TeamRoleRepository(db);
    roles = new RoleService(rolesRepo, permissionsRepo, userRolesRepo, teamRolesRepo);
  });

  async function userHasOpsCommandsRunner(userId: string): Promise<boolean> {
    const assigned = await userRolesRepo.listByUser(userId, 'org_main');
    for (const r of assigned) {
      const role = await rolesRepo.findById(r.roleId);
      if (role?.name === OPS_COMMANDS_RUNNER_ROLE_NAME) return true;
    }
    return false;
  }

  it('creates the SA user + org membership + ops-commands-runner role when missing', async () => {
    const id = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    expect(id).not.toBeNull();
    const user = await users.findByLogin(AUTO_INVESTIGATION_SA_LOGIN);
    expect(user).not.toBeNull();
    expect(user!.isServiceAccount).toBe(true);
    expect(user!.email).toBe(AUTO_INVESTIGATION_SA_EMAIL);
    const member = await orgUsers.findMembership('org_main', user!.id);
    expect(member?.role).toBe('Editor');
    expect(await userHasOpsCommandsRunner(user!.id)).toBe(true);
  });

  it('is idempotent: a second run is a no-op and the fixed role stays assigned exactly once', async () => {
    const id1 = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    const id2 = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    expect(id1).toBe(id2);
    const assigned = await userRolesRepo.listByUser(id1!, 'org_main');
    const matching: string[] = [];
    for (const r of assigned) {
      const role = await rolesRepo.findById(r.roleId);
      if (role?.name === OPS_COMMANDS_RUNNER_ROLE_NAME) matching.push(role.name);
    }
    expect(matching).toEqual([OPS_COMMANDS_RUNNER_ROLE_NAME]);
  });

  it('upgrades existing SA installs by assigning the fixed role on re-seed', async () => {
    // Simulate an "old" install: SA exists with Editor membership but no fixed role.
    const id = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    expect(id).not.toBeNull();
    expect(await userHasOpsCommandsRunner(id!)).toBe(false);
    // Re-seed (now with role service wired) — the fixed role must be added.
    const after = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    expect(after).toBe(id);
    expect(await userHasOpsCommandsRunner(id!)).toBe(true);
  });

  it('repairs missing org membership without recreating the user', async () => {
    const id = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    expect(id).not.toBeNull();
    // Drop the org membership row directly to simulate a partial seed
    const member = await orgUsers.findMembership('org_main', id!);
    expect(member).not.toBeNull();
    await orgUsers.remove('org_main', id!);
    const after = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    expect(after).toBe(id);
    const repaired = await orgUsers.findMembership('org_main', id!);
    expect(repaired?.role).toBe('Editor');
  });

  it('refuses to overwrite a non-SA user with login=openobs', async () => {
    await users.create({
      email: 'real@example.com',
      name: 'Real Person',
      login: AUTO_INVESTIGATION_SA_LOGIN,
      orgId: 'org_main',
      isAdmin: false,
      emailVerified: true,
    });
    const result = await seedAutoInvestigationSaIfNeeded({ users, orgUsers, roles });
    expect(result).toBeNull();
    const user = await users.findByLogin(AUTO_INVESTIGATION_SA_LOGIN);
    expect(user!.isServiceAccount).toBe(false);
  });
});
