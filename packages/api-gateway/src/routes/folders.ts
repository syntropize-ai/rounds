/**
 * /api/folders/* — folder CRUD + permissions.
 *
 * Implements docs/auth-perm-design/08-api-surface.md §/api/folders. The routes
 * are gated via `requirePermission(...)` against the RBAC evaluator; folder
 * CRUD uses `folders:*` actions, permissions endpoints use the
 * `folders.permissions:*` pair.
 *
 * Grafana reference (read for semantics only, nothing copied):
 *   pkg/api/folder.go
 *   pkg/api/folder_permissions.go
 */

import { Router } from 'express';
import type { Response } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { FolderService, FolderServiceError } from '../services/folder-service.js';
import {
  ResourcePermissionService,
  ResourcePermissionServiceError,
} from '../services/resource-permission-service.js';
import type { ResourcePermissionSetItem } from '@agentic-obs/common';

export interface FolderRouterDeps {
  folderService: FolderService;
  permissionService: ResourcePermissionService;
  ac: AccessControlService;
}

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof FolderServiceError) {
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
  if (err instanceof ResourcePermissionServiceError) {
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
}

export function createFolderRouter(deps: FolderRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // — GET /api/folders ------------------------------------------------------
  router.get(
    '/',
    requirePermission(ac.eval(ACTIONS.FoldersRead, 'folders:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parentQuery = req.query['parentUid'];
        const parentUid =
          parentQuery === undefined
            ? null // default: roots only (matches Grafana)
            : parentQuery === ''
              ? null
              : String(parentQuery);
        const limit = Number(req.query['limit'] ?? 200);
        const page = Number(req.query['page'] ?? 1);
        const offset = (Number.isFinite(page) && page > 0 ? page - 1 : 0) * limit;
        const query =
          typeof req.query['query'] === 'string'
            ? (req.query['query'] as string)
            : undefined;
        const items = await deps.folderService.list(req.auth!.orgId, {
          parentUid,
          query,
          limit,
          offset,
        });
        res.json(items);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/folders -----------------------------------------------------
  router.post(
    '/',
    requirePermission((req) => {
      const parentUid = (req.body as { parentUid?: string })?.parentUid;
      return ac.eval(
        ACTIONS.FoldersCreate,
        parentUid ? `folders:uid:${parentUid}` : 'folders:*',
      );
    }),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as {
          uid?: string;
          title?: string;
          description?: string;
          parentUid?: string;
        };
        if (!body.title) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'title is required' },
          });
          return;
        }
        const folder = await deps.folderService.create(
          req.auth!.orgId,
          {
            uid: body.uid,
            title: body.title,
            description: body.description,
            parentUid: body.parentUid,
          },
          req.auth!.userId,
        );
        res.status(200).json(folder);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/folders/:uid -------------------------------------------------
  router.get(
    '/:uid',
    requirePermission((req) =>
      ac.eval(ACTIONS.FoldersRead, `folders:uid:${req.params['uid']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const folder = await deps.folderService.getByUid(
          req.auth!.orgId,
          req.params['uid']!,
        );
        if (!folder) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'folder not found' },
          });
          return;
        }
        const parents = await deps.folderService.getParents(
          req.auth!.orgId,
          req.params['uid']!,
        );
        res.json({ ...folder, parents });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/folders/:uid/counts ------------------------------------------
  router.get(
    '/:uid/counts',
    requirePermission((req) =>
      ac.eval(ACTIONS.FoldersRead, `folders:uid:${req.params['uid']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const counts = await deps.folderService.getCounts(
          req.auth!.orgId,
          req.params['uid']!,
        );
        res.json(counts);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PUT /api/folders/:uid -------------------------------------------------
  router.put(
    '/:uid',
    requirePermission((req) =>
      ac.eval(ACTIONS.FoldersWrite, `folders:uid:${req.params['uid']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as {
          title?: string;
          description?: string | null;
          parentUid?: string | null;
        };
        const updated = await deps.folderService.update(
          req.auth!.orgId,
          req.params['uid']!,
          body,
          req.auth!.userId,
        );
        res.json(updated);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — DELETE /api/folders/:uid ----------------------------------------------
  router.delete(
    '/:uid',
    requirePermission((req) =>
      ac.eval(ACTIONS.FoldersDelete, `folders:uid:${req.params['uid']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const force =
          req.query['forceDeleteRules'] === 'true' ||
          req.query['forceDeleteRules'] === '1';
        await deps.folderService.delete(req.auth!.orgId, req.params['uid']!, {
          forceDeleteRules: force,
          actorId: req.auth!.userId,
        });
        res.status(200).json({ message: 'Folder deleted' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/folders/:uid/permissions -------------------------------------
  router.get(
    '/:uid/permissions',
    requirePermission((req) =>
      ac.eval(ACTIONS.FoldersPermissionsRead, `folders:uid:${req.params['uid']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const uid = req.params['uid']!;
        const existing = await deps.folderService.getByUid(req.auth!.orgId, uid);
        if (!existing) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'folder not found' },
          });
          return;
        }
        const entries = await deps.permissionService.list(
          req.auth!.orgId,
          'folders',
          uid,
        );
        res.json(entries);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/folders/:uid/permissions ------------------------------------
  router.post(
    '/:uid/permissions',
    requirePermission((req) =>
      ac.eval(ACTIONS.FoldersPermissionsWrite, `folders:uid:${req.params['uid']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const uid = req.params['uid']!;
        const existing = await deps.folderService.getByUid(req.auth!.orgId, uid);
        if (!existing) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'folder not found' },
          });
          return;
        }
        const body = req.body as { items?: ResourcePermissionSetItem[] };
        if (!Array.isArray(body.items)) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'items must be an array' },
          });
          return;
        }
        await deps.permissionService.setBulk(
          req.auth!.orgId,
          'folders',
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
