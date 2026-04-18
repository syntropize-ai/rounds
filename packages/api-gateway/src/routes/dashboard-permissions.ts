/**
 * /api/dashboards/uid/:uid/permissions — read + bulk-set dashboard permissions.
 *
 * Delegates to ResourcePermissionService. Folder cascade is resolved inside
 * the service via the dashboard's `folder_uid` column (populated by the
 * dashboards store when a dashboard is created/moved into a folder).
 *
 * Grafana reference (read for semantics only): pkg/api/dashboard_permissions.go
 */

import { Router } from 'express';
import type { Response } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import { sql } from 'drizzle-orm';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import {
  ResourcePermissionService,
  ResourcePermissionServiceError,
} from '../services/resource-permission-service.js';
import type { ResourcePermissionSetItem } from '@agentic-obs/common';
import type { SqliteClient } from '@agentic-obs/data-layer';

export interface DashboardPermissionsRouterDeps {
  permissionService: ResourcePermissionService;
  ac: AccessControlService;
  db: SqliteClient;
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

function readDashboardFolderUid(
  db: SqliteClient,
  orgId: string,
  uid: string,
): string | null {
  const rows = db.all<{ folder_uid: string | null }>(
    sql`SELECT folder_uid FROM dashboards WHERE org_id = ${orgId} AND id = ${uid} LIMIT 1`,
  );
  return rows[0]?.folder_uid ?? null;
}

export function createDashboardPermissionsRouter(
  deps: DashboardPermissionsRouterDeps,
): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // — GET /api/dashboards/uid/:uid/permissions ------------------------------
  router.get(
    '/uid/:uid/permissions',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.DashboardsPermissionsRead,
        `dashboards:uid:${req.params['uid']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const uid = req.params['uid']!;
        const folderUid = readDashboardFolderUid(deps.db, req.auth!.orgId, uid);
        const entries = await deps.permissionService.list(
          req.auth!.orgId,
          'dashboards',
          uid,
          { dashboardFolderUid: folderUid },
        );
        res.json(entries);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/dashboards/uid/:uid/permissions -----------------------------
  router.post(
    '/uid/:uid/permissions',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.DashboardsPermissionsWrite,
        `dashboards:uid:${req.params['uid']}`,
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
          'dashboards',
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
