/**
 * GET /api/user/permissions — returns the authenticated user's fully resolved
 * permissions in their current org, denormalized as `{action: [scope, ...]}`.
 *
 * See docs/auth-perm-design/03-rbac-model.md §user-permissions-endpoint and
 * 08-api-surface.md §/api/user/permissions. Frontend replaces its
 * ROLE_PERMISSIONS map with a call to this endpoint on login/org-switch.
 *
 * Performance: this endpoint runs after `authMiddleware` — the service layer
 * caches on `req.auth.permissions`, so repeat invocations within a request
 * are cheap.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { permissionsAsMap } from './access-control.js';
import { asyncHandler } from '../middleware/async-handler.js';

export function createUserPermissionsRouter(ac: AccessControlService): Router {
  const router = Router();

  router.get('/permissions', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'authentication required' },
      });
      return;
    }
    try {
      const perms = await ac.ensurePermissions(req.auth);
      res.json(permissionsAsMap(perms));
    } catch (err) {
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'internal error',
        },
      });
    }
  }));

  return router;
}
