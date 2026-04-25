/**
 * /api/auth/keys — legacy Grafana API keys endpoint.
 *
 * Per docs/auth-perm-design/08-api-surface.md §/api/auth/keys we keep this
 * route for tooling that predates the service-account model. New code should
 * prefer /api/serviceaccounts/:id/tokens.
 *
 * Mirrors `pkg/api/apikey.go` HTTP contract:
 *   POST   /api/auth/keys  body: { name, role, secondsToLive? } → 200 { id, name, key }
 *   GET    /api/auth/keys                                       → 200 [{ id, name, role, expiration }]
 *   DELETE /api/auth/keys/:id                                   → 200 { message }
 *
 * Implementation note: we transparently create an SA named "legacy-<key-name>"
 * the first time a legacy POST arrives and issue an SA token for it. This
 * keeps the internal data model uniform (no special "orphan key" rows) while
 * honouring the legacy surface.
 */

import { Router, type NextFunction, type Response } from 'express';
import {
  ac,
  ACTIONS,
  AppError,
  ORG_ROLES,
  type OrgRole,
} from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { tokenIssueRateLimiter } from '../middleware/rate-limiter.js';
import {
  ServiceAccountService,
  ServiceAccountServiceError,
} from '../services/serviceaccount-service.js';
import { ApiKeyService } from '../services/apikey-service.js';

export interface AuthKeysRouterDeps {
  serviceAccounts: ServiceAccountService;
  apiKeys: ApiKeyService;
  ac: AccessControlService;
}

/**
 * Forward service-layer errors to the global error-handler middleware.
 * `ApiKeyService` now throws `AppError` subclasses, so they render with the
 * canonical `{ error: { code, message } }` envelope automatically. The only
 * pre-AppError hierarchy still live is `ServiceAccountServiceError` (audit
 * item §12 flagged it); we translate it here until it's migrated too.
 */
function forwardError(err: unknown, next: NextFunction): void {
  if (err instanceof AppError) {
    next(err);
    return;
  }
  if (err instanceof ServiceAccountServiceError) {
    const code = err.statusCode === 404 ? 'NOT_FOUND'
      : err.statusCode === 409 ? 'CONFLICT'
      : err.statusCode === 403 ? 'FORBIDDEN'
      : err.statusCode >= 500 ? 'INTERNAL_ERROR'
      : 'VALIDATION';
    const wrapped = new AppError(code, err.statusCode, err.message);
    next(wrapped);
    return;
  }
  next(err);
}

export function createAuthKeysRouter(deps: AuthKeysRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // -- GET /api/auth/keys --------------------------------------------------
  router.get(
    '/',
    requirePermission(ac.eval(ACTIONS.ApiKeysRead, 'apikeys:*')),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        // All SA tokens + all PATs in the current org. Shape matches
        // Grafana's legacy list response (id/name/role/expiration).
        const { items } = await deps.serviceAccounts.list(req.auth!.orgId, {
          limit: 1000,
        });
        const keys: Array<{
          id: string;
          name: string;
          role: string;
          expiration: string | null;
        }> = [];
        for (const sa of items) {
          const tokens = await deps.apiKeys.listByServiceAccount(
            req.auth!.orgId,
            sa.id,
          );
          for (const t of tokens) {
            if (t.isRevoked) continue;
            keys.push({
              id: t.id,
              name: t.name,
              role: t.role,
              expiration: t.expires,
            });
          }
        }
        res.json(keys);
      } catch (err) {
        forwardError(err, next);
      }
    },
  );

  // -- POST /api/auth/keys -------------------------------------------------
  // Strict per-user 5/min cap (token-issue limiter) — see
  // `middleware/rate-limiter.ts`. Same protection as
  // `POST /api/serviceaccounts/:id/tokens` (this endpoint provisions an SA
  // and issues a token in one shot, same blast radius).
  router.post(
    '/',
    tokenIssueRateLimiter,
    requirePermission(ac.eval(ACTIONS.ApiKeysCreate)),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const body = (req.body ?? {}) as {
          name?: string;
          role?: string;
          secondsToLive?: number | null;
        };
        if (!body.name) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'name is required' },
          });
          return;
        }
        const role = body.role ?? 'Viewer';
        if (!(ORG_ROLES as readonly string[]).includes(role)) {
          res.status(400).json({
            error: {
              code: 'VALIDATION',
              message: `role must be one of: ${ORG_ROLES.join(', ')}`,
            },
          });
          return;
        }

        // Provision a hidden SA named legacy-<key-name> and issue a token.
        const saName = `legacy-${body.name}`;
        let sa = (
          await deps.serviceAccounts.list(req.auth!.orgId, { query: saName })
        ).items.find((s) => s.name === saName);
        if (!sa) {
          sa = await deps.serviceAccounts.create(
            req.auth!.orgId,
            req.auth!.userId,
            { name: saName, role: role as OrgRole },
          );
        }
        const issued = await deps.apiKeys.issueServiceAccountToken(
          req.auth!.orgId,
          sa.id,
          {
            name: body.name,
            secondsToLive: body.secondsToLive,
          },
        );
        res.status(200).json({
          id: issued.id,
          name: issued.name,
          key: issued.key,
        });
      } catch (err) {
        forwardError(err, next);
      }
    },
  );

  // -- DELETE /api/auth/keys/:id ------------------------------------------
  router.delete(
    '/:id',
    requirePermission(ac.eval(ACTIONS.ApiKeysDelete)),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const token = await deps.apiKeys.getById(
          req.auth!.orgId,
          req.params['id']!,
        );
        if (!token) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'api key not found' },
          });
          return;
        }
        await deps.apiKeys.revoke(
          req.auth!.orgId,
          token.id,
          req.auth!.userId,
        );
        res.json({ message: 'API key deleted' });
      } catch (err) {
        forwardError(err, next);
      }
    },
  );

  return router;
}
