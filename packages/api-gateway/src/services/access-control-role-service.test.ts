import { describe, expect, it } from 'vitest';
import {
  createTestDb,
  PermissionRepository,
  RoleRepository,
  TeamRoleRepository,
  UserRoleRepository,
} from '@agentic-obs/data-layer';
import { AccessControlRoleService, AccessControlSeedUnavailableError } from './access-control-role-service.js';

function createService(db = createTestDb()): AccessControlRoleService {
  return new AccessControlRoleService({
    roleRepo: new RoleRepository(db),
    permissionRepo: new PermissionRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    db,
  });
}

describe('AccessControlRoleService', () => {
  it('owns RoleService construction for role operations', async () => {
    const service = createService();

    await expect(service.roles.listRoles({ orgId: 'org_main' })).resolves.toEqual([]);
  });

  it('throws a typed error when seed support is unavailable', async () => {
    const db = createTestDb();
    const service = new AccessControlRoleService({
      roleRepo: new RoleRepository(db),
      permissionRepo: new PermissionRepository(db),
      userRoles: new UserRoleRepository(db),
      teamRoles: new TeamRoleRepository(db),
    });

    await expect(service.seed('org_main')).rejects.toBeInstanceOf(AccessControlSeedUnavailableError);
  });
});
