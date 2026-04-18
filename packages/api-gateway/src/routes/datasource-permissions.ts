/**
 * /api/datasources/:uid/permissions — read + bulk-set datasource permissions.
 *
 * Datasources are flat (no folder cascade). Actions:
 *   View  => datasources:query
 *   Edit  => + datasources:write
 *   Admin => + datasources.permissions:*
 *
 * Grafana reference (read for semantics only): pkg/api/datasource_permissions.go
 */

import { Router } from 'express';
import type { Response } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import {
  ResourcePermissionService,
  ResourcePermissionServiceError,
} from '../services/resource-permission-service.js';
import type { ResourcePermissionSetItem } from '@agentic-obs/common';

export interface DatasourcePermissionsRouterDeps {
  permissionService: ResourcePermissionService;
  ac: AccessControlService;
}

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof ResourcePermissionServiceError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }
  res.status(500).json({
    message: err instanceof Error ? err.message : 'internal error',
  });
}

export function createDatasourcePermissionsRouter(
  deps: DatasourcePermissionsRouterDeps,
): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  router.get(
    '/:uid/permissions',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.DatasourcesPermissionsRead,
        `datasources:uid:${req.params['uid']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const uid = req.params['uid']!;
        const entries = await deps.permissionService.list(
          req.auth!.orgId,
          'datasources',
          uid,
        );
        res.json(entries);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.post(
    '/:uid/permissions',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.DatasourcesPermissionsWrite,
        `datasources:uid:${req.params['uid']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const uid = req.params['uid']!;
        const body = req.body as { items?: ResourcePermissionSetItem[] };
        if (!Array.isArray(body.items)) {
          res.status(400).json({ message: 'items must be an array' });
          return;
        }
        await deps.permissionService.setBulk(
          req.auth!.orgId,
          'datasources',
          uid,
          body.items,
        );
        res.status(200).json({ message: 'Permissions updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
