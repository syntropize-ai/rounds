/**
 * /api/user/access-tokens — personal access token endpoints.
 *
 * [openobs-extension] — Grafana deprecated PATs in favour of SA tokens. We
 * keep them for CLI/scripts that need to impersonate a specific human user.
 * Permissions derive from the owning user's org role + role assignments, so
 * a PAT never grants more than its owner already has.
 *
 * Mirrors the shape of `/api/user/auth-tokens` (session tokens) intentionally
 * so the frontend uses one consistent data model. The path `access-tokens`
 * is distinct from `auth-tokens` (session) and `tokens` (also session) to
 * avoid collision with existing routes.
 *
 * Auth: every endpoint here requires the caller to be authenticated. A PAT
 * owner manages their OWN tokens; admins can manage any via /api/admin — we
 * do not implement the admin-path here (out of scope for T6; filed in report).
 */

import { Router, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  ApiKeyService,
  ApiKeyServiceError,
} from '../services/apikey-service.js';

export interface UserTokensRouterDeps {
  apiKeys: ApiKeyService;
}

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof ApiKeyServiceError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }
  res.status(500).json({
    message: err instanceof Error ? err.message : 'internal error',
  });
}

export function createUserTokensRouter(deps: UserTokensRouterDeps): Router {
  const router = Router();

  // -- GET /api/user/access-tokens ----------------------------------------
  // Lists PATs owned by the authenticated user in their current org.
  router.get(
    '/access-tokens',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({ message: 'authentication required' });
        return;
      }
      try {
        const tokens = await deps.apiKeys.listByOwner(
          req.auth.orgId,
          req.auth.userId,
        );
        res.json(
          tokens.map((t) => ({
            id: t.id,
            name: t.name,
            role: t.role,
            created: t.created,
            updated: t.updated,
            lastUsedAt: t.lastUsedAt,
            expires: t.expires,
            isRevoked: t.isRevoked,
          })),
        );
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- POST /api/user/access-tokens ---------------------------------------
  router.post(
    '/access-tokens',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({ message: 'authentication required' });
        return;
      }
      try {
        const body = (req.body ?? {}) as {
          name?: string;
          secondsToLive?: number | null;
        };
        if (!body.name) {
          res.status(400).json({ message: 'name is required' });
          return;
        }
        const issued = await deps.apiKeys.issuePersonalAccessToken(
          req.auth.orgId,
          req.auth.userId,
          {
            name: body.name,
            secondsToLive: body.secondsToLive,
          },
        );
        res.status(201).json({
          id: issued.id,
          name: issued.name,
          key: issued.key,
          expires: issued.expires,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- DELETE /api/user/access-tokens/:id ---------------------------------
  router.delete(
    '/access-tokens/:id',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({ message: 'authentication required' });
        return;
      }
      try {
        const tokenId = req.params['id']!;
        const token = await deps.apiKeys.getById(req.auth.orgId, tokenId);
        if (!token) {
          res.status(404).json({ message: 'token not found' });
          return;
        }
        // PAT owners can only revoke their own tokens. Server admins bypass
        // (they can manage any token in their org).
        if (token.ownerUserId !== req.auth.userId && !req.auth.isServerAdmin) {
          res.status(403).json({ message: 'not the owner of this token' });
          return;
        }
        await deps.apiKeys.revoke(req.auth.orgId, token.id, req.auth.userId);
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
