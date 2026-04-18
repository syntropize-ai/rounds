/**
 * /api/access-control/alert.rules/:folderUid/permissions — read + bulk-set
 * alert rule permissions.
 *
 * Alert rules inherit permissions from the containing folder; permissions are
 * therefore addressed by the folder UID, NOT the rule UID. Matches Grafana.
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

export interface AlertRulePermissionsRouterDeps {
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

export function createAlertRulePermissionsRouter(
  deps: AlertRulePermissionsRouterDeps,
): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  router.get(
    '/:folderUid/permissions',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.AlertRulesPermissionsRead,
        `folders:uid:${req.params['folderUid']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const folderUid = req.params['folderUid']!;
        // We target the folder UID directly — alert-rule permissions in
        // Grafana are stored on the folder scope, with the "alert.rules"
        // resource kind determining which action set is applied.
        const entries = await deps.permissionService.list(
          req.auth!.orgId,
          'alert.rules',
          folderUid,
        );
        res.json(entries);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  router.post(
    '/:folderUid/permissions',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.AlertRulesPermissionsWrite,
        `folders:uid:${req.params['folderUid']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const folderUid = req.params['folderUid']!;
        const body = req.body as { items?: ResourcePermissionSetItem[] };
        if (!Array.isArray(body.items)) {
          res.status(400).json({ message: 'items must be an array' });
          return;
        }
        await deps.permissionService.setBulk(
          req.auth!.orgId,
          'alert.rules',
          folderUid,
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
