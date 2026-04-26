/**
 * /api/access-control/* — role CRUD, role assignments, permission inspect.
 *
 * See docs/auth-perm-design/08-api-surface.md §access-control.
 *
 * Grafana reference (read for semantics only):
 *   pkg/api/accesscontrol.go.
 *
 * Every mutation route is gated by `requirePermission(ac.eval('roles:*'))` or
 * an action-specific evaluator. See ACTIONS in @agentic-obs/common/rbac/actions.
 */

import { Router } from 'express';
import type { NextFunction, Response } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { RoleServiceError } from '../services/role-service.js';
import { AccessControlRoleService, AccessControlSeedUnavailableError } from '../services/access-control-role-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type {
  IRoleRepository,
  IPermissionRepository,
  IUserRoleRepository,
  ITeamRoleRepository,
} from '@agentic-obs/common';

export interface AccessControlRouterDeps {
  ac: AccessControlService;
  roleRepo: IRoleRepository;
  permissionRepo: IPermissionRepository;
  userRoles: IUserRoleRepository;
  teamRoles: ITeamRoleRepository;
  /** Raw DB handle — optional seed support for deployments that expose it. */
  db?: SqliteClient;
}

// Shape the route layer returns — mirrors Grafana's RoleDTO.
interface RoleDTO {
  uid: string;
  name: string;
  displayName: string | null;
  description: string | null;
  group: string | null;
  global: boolean;
  version: number;
  hidden: boolean;
  orgId: string;
  created: string;
  updated: string;
  permissions: Array<{ action: string; scope: string }>;
}

function toDTO(role: {
  uid: string;
  name: string;
  displayName: string | null;
  description: string | null;
  groupName: string | null;
  orgId: string;
  version: number;
  hidden: boolean;
  created: string;
  updated: string;
}, permissions: Array<{ action: string; scope: string }>): RoleDTO {
  return {
    uid: role.uid,
    name: role.name,
    displayName: role.displayName,
    description: role.description,
    group: role.groupName,
    global: role.orgId === '',
    version: role.version,
    hidden: role.hidden,
    orgId: role.orgId,
    created: role.created,
    updated: role.updated,
    permissions,
  };
}

export function createAccessControlRouter(
  deps: AccessControlRouterDeps,
): Router {
  const router = Router();
  const roleFacade = new AccessControlRoleService(deps);
  const service = roleFacade.roles;
  const requirePermission = createRequirePermission(deps.ac);

  // Helper: handle RoleServiceError with the service's status code.
  const handleServiceError = (err: unknown, res: Response): void => {
    if (err instanceof RoleServiceError) {
      const code = err.statusCode >= 500 ? 'INTERNAL_ERROR'
        : err.statusCode === 404 ? 'NOT_FOUND'
        : err.statusCode === 409 ? 'CONFLICT'
        : err.statusCode === 403 ? 'FORBIDDEN'
        : 'VALIDATION';
      res.status(err.statusCode).json({
        error: { code, message: err.message },
      });
      return;
    }
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'internal error',
      },
    });
  };

  // -- Status (no auth gate — used by frontend bootstrap) -----------------
  router.get('/status', (_req, res: Response) => {
    res.json({ enabled: true, rbacEnabled: true });
  });

  // -- Seed (server admin) ------------------------------------------------
  router.post(
    '/seed',
    requirePermission((req) => {
      void req;
      // Seeding is a server-admin operation. Evaluator demands roles:write
      // globally — basic:server_admin satisfies it by virtue of ALL_ACTIONS.
      return ac.eval(ACTIONS.RolesWrite, 'roles:*');
    }),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await roleFacade.seed(req.auth!.orgId);
        res.json(result);
      } catch (err) {
        if (err instanceof AccessControlSeedUnavailableError) {
          res.status(501).json({
            error: {
              code: 'NOT_IMPLEMENTED',
              message: err.message,
            },
          });
          return;
        }
        handleServiceError(err, res);
      }
    },
  );

  // -- Roles: list + create ------------------------------------------------
  router.get(
    '/roles',
    requirePermission(ac.eval(ACTIONS.RolesRead, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const includeHidden = req.query['includeHidden'] === 'true';
        const roles = await service.listRoles({
          orgId: req.auth!.orgId,
          includeHidden,
        });
        res.json(
          roles.map((r) =>
            toDTO(
              r.role,
              r.permissions.map((p) => ({ action: p.action, scope: p.scope })),
            ),
          ),
        );
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.post(
    '/roles',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as {
          name?: string;
          uid?: string;
          displayName?: string;
          description?: string;
          group?: string;
          hidden?: boolean;
          global?: boolean;
          permissions?: Array<{ action: string; scope?: string }>;
        };
        if (!body.name) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'name is required' },
          });
          return;
        }
        const orgId = body.global ? '' : req.auth!.orgId;
        const result = await service.createRole({
          name: body.name,
          uid: body.uid,
          displayName: body.displayName ?? null,
          description: body.description ?? null,
          groupName: body.group ?? null,
          hidden: body.hidden,
          orgId,
          permissions: body.permissions ?? [],
        });
        res
          .status(201)
          .json(
            toDTO(
              result.role,
              result.permissions.map((p) => ({ action: p.action, scope: p.scope })),
            ),
          );
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- Roles: get / put / delete ------------------------------------------
  router.get(
    '/roles/:roleUid',
    requirePermission(ac.eval(ACTIONS.RolesRead, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await service.getRole(
          req.auth!.orgId,
          req.params['roleUid']!,
        );
        if (!result) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'role not found' },
          });
          return;
        }
        res.json(
          toDTO(
            result.role,
            result.permissions.map((p) => ({ action: p.action, scope: p.scope })),
          ),
        );
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.put(
    '/roles/:roleUid',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as {
          version?: number;
          displayName?: string;
          description?: string;
          group?: string;
          hidden?: boolean;
          permissions?: Array<{ action: string; scope?: string }>;
        };
        if (typeof body.version !== 'number') {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'version is required' },
          });
          return;
        }
        const result = await service.updateRole({
          roleUid: req.params['roleUid']!,
          orgId: req.auth!.orgId,
          version: body.version,
          displayName: body.displayName,
          description: body.description,
          groupName: body.group,
          hidden: body.hidden,
          permissions: body.permissions,
        });
        res.json(
          toDTO(
            result.role,
            result.permissions.map((p) => ({ action: p.action, scope: p.scope })),
          ),
        );
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.delete(
    '/roles/:roleUid',
    requirePermission(ac.eval(ACTIONS.RolesDelete, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ok = await service.deleteRole(
          req.auth!.orgId,
          req.params['roleUid']!,
        );
        if (!ok) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'role not found' },
          });
          return;
        }
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- User role assignments ----------------------------------------------
  router.get(
    '/users/:userId/roles',
    requirePermission(ac.eval(ACTIONS.RolesRead, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roles = await service.listUserRoles(
          req.auth!.orgId,
          req.params['userId']!,
        );
        res.json(roles.map((r) => ({ uid: r.uid, name: r.name, orgId: r.orgId })));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.post(
    '/users/:userId/roles',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { roleUid?: string };
        if (!body.roleUid) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'roleUid is required' },
          });
          return;
        }
        await service.assignRoleToUser(
          req.auth!.orgId,
          req.params['userId']!,
          body.roleUid,
        );
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.delete(
    '/users/:userId/roles/:roleUid',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ok = await service.unassignRoleFromUser(
          req.auth!.orgId,
          req.params['userId']!,
          req.params['roleUid']!,
        );
        if (!ok) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'assignment not found' },
          });
          return;
        }
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.put(
    '/users/:userId/roles',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { roleUids?: string[] };
        if (!Array.isArray(body.roleUids)) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'roleUids must be an array' },
          });
          return;
        }
        await service.setUserRoles(
          req.auth!.orgId,
          req.params['userId']!,
          body.roleUids,
        );
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- Team role assignments ----------------------------------------------
  router.get(
    '/teams/:teamId/roles',
    requirePermission(ac.eval(ACTIONS.RolesRead, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roles = await service.listTeamRoles(
          req.auth!.orgId,
          req.params['teamId']!,
        );
        res.json(roles.map((r) => ({ uid: r.uid, name: r.name, orgId: r.orgId })));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.post(
    '/teams/:teamId/roles',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { roleUid?: string };
        if (!body.roleUid) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'roleUid is required' },
          });
          return;
        }
        await service.assignRoleToTeam(
          req.auth!.orgId,
          req.params['teamId']!,
          body.roleUid,
        );
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.delete(
    '/teams/:teamId/roles/:roleUid',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ok = await service.unassignRoleFromTeam(
          req.auth!.orgId,
          req.params['teamId']!,
          req.params['roleUid']!,
        );
        if (!ok) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'assignment not found' },
          });
          return;
        }
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.put(
    '/teams/:teamId/roles',
    requirePermission(ac.eval(ACTIONS.RolesWrite, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { roleUids?: string[] };
        if (!Array.isArray(body.roleUids)) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'roleUids must be an array' },
          });
          return;
        }
        await service.setTeamRoles(
          req.auth!.orgId,
          req.params['teamId']!,
          body.roleUids,
        );
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- User permissions inspect (admin-scoped lookups for a specific user) -
  router.get(
    '/users/:userId/permissions',
    requirePermission(ac.eval(ACTIONS.RolesRead, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // Resolve permissions for the target user by constructing an identity
        // shim — we re-use the service's resolver rather than duplicating it.
        const targetIdentity = {
          userId: req.params['userId']!,
          orgId: req.auth!.orgId,
          orgRole: 'None' as const,
          isServerAdmin: false,
          authenticatedBy: req.auth!.authenticatedBy,
        };
        const perms = await deps.ac.getUserPermissions(targetIdentity);
        res.json(permissionsAsMap(perms));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.get(
    '/users/permissions/search',
    requirePermission(ac.eval(ACTIONS.RolesRead, 'roles:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const action = req.query['action'];
        if (typeof action !== 'string') {
          res.status(400).json({
            error: {
              code: 'VALIDATION',
              message: 'action query param is required',
            },
          });
          return;
        }
        const rows = await deps.permissionRepo.listByAction(action);
        res.json(rows.map((p) => ({ roleId: p.roleId, action: p.action, scope: p.scope })));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- Error handler bound to router ---------------------------------------
  router.use(
    (err: unknown, _req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
      handleServiceError(err, res);
    },
  );

  return router;
}

/**
 * Denormalize a flat permission list into `{ action: [scope, scope, ...] }`.
 * Shape matches docs/auth-perm-design/03-rbac-model.md §user-permissions-endpoint.
 */
export function permissionsAsMap(
  perms: Array<{ action: string; scope: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of perms) {
    if (!out[p.action]) out[p.action] = [];
    if (!out[p.action]!.includes(p.scope)) out[p.action]!.push(p.scope);
  }
  return out;
}
