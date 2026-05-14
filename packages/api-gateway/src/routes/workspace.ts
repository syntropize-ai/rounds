/**
 * /api/workspace/me — current user's "My Workspace" (Wave 1 / PR-C).
 *
 * Returns (and lazily creates) the caller's personal folder plus a counts
 * snapshot. The folder uid is deterministic — `user:<userId>` — so this is
 * idempotent across processes.
 *
 * Scope: read-only. Folder creation is internal to this handler; the public
 * `POST /api/folders` rejects `kind: 'personal'`.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { FolderService } from '../services/folder-service.js';
import { FolderServiceError } from '../services/folder-service.js';
import type { IUserRepository } from '@agentic-obs/common';

export interface WorkspaceRouterDeps {
  folderService: FolderService;
  users: IUserRepository;
}

export function createWorkspaceRouter(deps: WorkspaceRouterDeps): Router {
  const router = Router();

  // — GET /api/workspace/me -------------------------------------------------
  router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { orgId, userId } = req.auth!;
      const user = await deps.users.findById(userId);
      // `name` is sometimes empty (e.g. SSO users with only login). Fall back
      // to login, then to the userId so the title is never just "'s workspace".
      const displayName =
        user?.name?.trim() || user?.login?.trim() || userId;
      const folder = await deps.folderService.getOrCreatePersonal(
        orgId,
        userId,
        displayName,
      );
      const counts = await deps.folderService.getCounts(orgId, folder.uid);
      res.json({ folder, counts });
    } catch (err) {
      if (err instanceof FolderServiceError) {
        res.status(err.statusCode).json({
          error: { code: 'VALIDATION', message: err.message },
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
  });

  return router;
}
