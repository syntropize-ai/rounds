/**
 * /api/resources/:kind/:id/promote — Wave 2 step 1.
 *
 * Single endpoint that powers the promote-confirm flow:
 *   - GET /preview is folded into POST without `?confirmed=true`.
 *   - With `?confirmed=true` the promote actually runs.
 *
 * Body: `{ targetFolderUid, owner?, description? }`
 *
 * RBAC: PromoteService asserts BOTH source resource write AND target
 * folder write. The route itself doesn't pre-gate (the service does the
 * check during preview anyway — a single 403 path keeps the message
 * consistent between preview and confirm).
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  PromoteService,
  PromoteServiceError,
  type PromoteKind,
} from '../services/promote-service.js';
import type { Identity } from '@agentic-obs/common';

export interface ResourcesPromoteRouterDeps {
  promoteService: PromoteService;
}

function parseKind(raw: string | undefined): PromoteKind | null {
  if (raw === 'dashboard' || raw === 'alert_rule') return raw;
  return null;
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof PromoteServiceError) {
    const code = err.statusCode === 404
      ? 'NOT_FOUND'
      : err.statusCode === 403
        ? 'FORBIDDEN'
        : err.statusCode === 409
          ? 'CONFLICT'
          : 'VALIDATION';
    res.status(err.statusCode).json({ error: { code, message: err.message } });
    return;
  }
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'internal error',
    },
  });
}

export function createResourcesPromoteRouter(deps: ResourcesPromoteRouterDeps): Router {
  const router = Router();
  router.use(authMiddleware);

  router.post(
    '/:kind/:id/promote',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const kind = parseKind(req.params['kind']);
        if (!kind) {
          res.status(400).json({
            error: {
              code: 'VALIDATION',
              message: "kind must be 'dashboard' or 'alert_rule'",
            },
          });
          return;
        }
        const id = req.params['id'] ?? '';
        if (!id) {
          res.status(400).json({ error: { code: 'VALIDATION', message: 'id is required' } });
          return;
        }
        const body = (req.body ?? {}) as {
          targetFolderUid?: string;
          owner?: string;
          description?: string;
        };
        if (!body.targetFolderUid) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'targetFolderUid is required' },
          });
          return;
        }

        const identity = (req as AuthenticatedRequest).auth as Identity;
        const input = {
          kind,
          id,
          targetFolderUid: body.targetFolderUid,
          ...(body.owner !== undefined ? { owner: body.owner } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        };

        const confirmed = req.query['confirmed'] === 'true' || req.query['confirmed'] === '1';
        if (!confirmed) {
          const preview = await deps.promoteService.preview(identity, input);
          res.status(200).json({ kind: 'preview', preview });
          return;
        }
        const result = await deps.promoteService.promote(identity, input);
        res.status(200).json({ kind: 'result', result });
      } catch (err) {
        if (err instanceof PromoteServiceError) {
          handleError(err, res);
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
