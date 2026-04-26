import { seedRbacForOrg } from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type {
  IPermissionRepository,
  IRoleRepository,
  ITeamRoleRepository,
  IUserRoleRepository,
} from '@agentic-obs/common';
import { RoleService } from './role-service.js';

export interface AccessControlRoleServiceDeps {
  roleRepo: IRoleRepository;
  permissionRepo: IPermissionRepository;
  userRoles: IUserRoleRepository;
  teamRoles: ITeamRoleRepository;
  db?: SqliteClient;
}

export class AccessControlSeedUnavailableError extends Error {
  constructor() {
    super('seed not available in this deployment');
    this.name = 'AccessControlSeedUnavailableError';
  }
}

export class AccessControlRoleService {
  readonly roles: RoleService;

  constructor(private readonly deps: AccessControlRoleServiceDeps) {
    this.roles = new RoleService(
      deps.roleRepo,
      deps.permissionRepo,
      deps.userRoles,
      deps.teamRoles,
    );
  }

  async seed(orgId: string): Promise<Awaited<ReturnType<typeof seedRbacForOrg>>> {
    if (!this.deps.db) {
      throw new AccessControlSeedUnavailableError();
    }
    return seedRbacForOrg(this.deps.db, orgId);
  }
}
