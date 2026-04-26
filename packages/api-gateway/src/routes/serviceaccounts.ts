/**
 * /api/serviceaccounts/* — service-account CRUD + tokens + legacy migration.
 *
 * Mirrors docs/auth-perm-design/08-api-surface.md §service-accounts which
 * mirrors Grafana's `pkg/api/serviceaccounts.go` routes (read for semantics
 * only, nothing copied).
 *
 * All endpoints gated via `requirePermission` against the actions in
 * `ACTIONS.ServiceAccounts*`. Token endpoints reuse `ServiceAccountsWrite`
 * with `serviceaccounts:id:<id>` scope — matches Grafana.
 */

import { Router, type Response } from 'express';
import {
  ac,
  ACTIONS,
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
import { AppError } from '@agentic-obs/common';

export interface ServiceAccountsRouterDeps {
  serviceAccounts: ServiceAccountService;
  apiKeys: ApiKeyService;
  ac: AccessControlService;
}

/**
 * Map service-layer errors onto the canonical `{ error: { code, message } }`
 * envelope. `ApiKeyService` now throws `AppError` subclasses directly, so we
 * just emit them raw; `ServiceAccountService` still uses its own hierarchy
 * (audit item §12) and gets wrapped here.
 */
function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof AppError) {
    const body = err.statusCode >= 500
      ? { error: { code: err.code, message: 'Internal server error' } }
      : { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
    res.status(err.statusCode).json(body);
    return;
  }
  if (err instanceof ServiceAccountServiceError) {
    const code = err.statusCode === 404 ? 'NOT_FOUND'
      : err.statusCode === 409 ? 'CONFLICT'
      : err.statusCode === 403 ? 'FORBIDDEN'
      : err.statusCode >= 500 ? 'INTERNAL_ERROR'
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

function parseListOpts(req: AuthenticatedRequest): {
  query?: string;
  limit: number;
  offset: number;
  disabled?: boolean;
} {
  const query =
    typeof req.query['query'] === 'string'
      ? (req.query['query'] as string)
      : undefined;
  const perpage = Number(req.query['perpage'] ?? 50);
  const page = Number(req.query['page'] ?? 1);
  const limit =
    Number.isFinite(perpage) && perpage > 0 ? Math.floor(perpage) : 50;
  const pageNum = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const rawDisabled = req.query['disabled'];
  let disabled: boolean | undefined;
  if (typeof rawDisabled === 'string' && rawDisabled !== '') {
    disabled = rawDisabled === 'true' || rawDisabled === '1';
  }
  return { query, limit, offset: (pageNum - 1) * limit, disabled };
}

export function createServiceAccountsRouter(
  deps: ServiceAccountsRouterDeps,
): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // -- POST /api/serviceaccounts ------------------------------------------
  router.post(
    '/',
    requirePermission(ac.eval(ACTIONS.ServiceAccountsCreate)),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as {
          name?: string;
          role?: string;
          isDisabled?: boolean;
        };
        if (!body.name) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'name is required' },
          });
          return;
        }
        if (!body.role || !(ORG_ROLES as readonly string[]).includes(body.role)) {
          res.status(400).json({
            error: {
              code: 'VALIDATION',
              message: `role must be one of: ${ORG_ROLES.join(', ')}`,
            },
          });
          return;
        }
        const sa = await deps.serviceAccounts.create(
          req.auth!.orgId,
          req.auth!.userId,
          {
            name: body.name,
            role: body.role as OrgRole,
            isDisabled: body.isDisabled,
          },
        );
        res.status(201).json(sa);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- POST /api/serviceaccounts/migrate ----------------------------------
  // Must precede /:id to avoid route conflict.
  router.post(
    '/migrate',
    requirePermission(ac.eval(ACTIONS.ServiceAccountsCreate)),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const legacyKeys = deps.apiKeys.parseLegacyEnv();
        const mappings: Array<{
          legacyName: string;
          newSaId: string;
          newSaLogin: string;
          keyId: string;
          skipped: boolean;
        }> = [];
        for (const legacy of legacyKeys) {
          const saName = `Migrated ${legacy.name}`;
          const existingSA = await deps.serviceAccounts
            .list(req.auth!.orgId, { query: saName, limit: 5 })
            .then((p) => p.items.find((i) => i.name === saName));
          let saId: string;
          let saLogin: string;
          let skipped = false;
          if (existingSA) {
            saId = existingSA.id;
            saLogin = existingSA.login;
            skipped = true;
          } else {
            const created = await deps.serviceAccounts.create(
              req.auth!.orgId,
              req.auth!.userId,
              { name: saName, role: 'Viewer' },
            );
            saId = created.id;
            saLogin = created.login;
          }
          const imported = await deps.apiKeys.importLegacyKeyForSA(
            req.auth!.orgId,
            saId,
            legacy.name,
            legacy.key,
          );
          mappings.push({
            legacyName: legacy.name,
            newSaId: saId,
            newSaLogin: saLogin,
            keyId: imported.id,
            skipped,
          });
        }
        res.status(200).json({ migrated: mappings });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- GET /api/serviceaccounts/search ------------------------------------
  router.get(
    '/search',
    requirePermission(ac.eval(ACTIONS.ServiceAccountsRead, 'serviceaccounts:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const opts = parseListOpts(req);
        const page = await deps.serviceAccounts.list(req.auth!.orgId, opts);
        res.json({
          totalCount: page.total,
          serviceAccounts: page.items,
          page: Math.floor(opts.offset / opts.limit) + 1,
          perPage: opts.limit,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- GET /api/serviceaccounts/:id ---------------------------------------
  router.get(
    '/:id',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.ServiceAccountsRead,
        `serviceaccounts:id:${req.params['id']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sa = await deps.serviceAccounts.getById(
          req.auth!.orgId,
          req.params['id']!,
        );
        if (!sa) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'service account not found' },
          });
          return;
        }
        res.json(sa);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- PATCH /api/serviceaccounts/:id -------------------------------------
  router.patch(
    '/:id',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.ServiceAccountsWrite,
        `serviceaccounts:id:${req.params['id']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as {
          name?: string;
          role?: string;
          isDisabled?: boolean;
        };
        if (
          body.role !== undefined &&
          !(ORG_ROLES as readonly string[]).includes(body.role)
        ) {
          res.status(400).json({
            error: {
              code: 'VALIDATION',
              message: `role must be one of: ${ORG_ROLES.join(', ')}`,
            },
          });
          return;
        }
        const sa = await deps.serviceAccounts.update(
          req.auth!.orgId,
          req.params['id']!,
          req.auth!.userId,
          {
            name: body.name,
            role: body.role as OrgRole | undefined,
            isDisabled: body.isDisabled,
          },
        );
        res.json(sa);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- DELETE /api/serviceaccounts/:id ------------------------------------
  router.delete(
    '/:id',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.ServiceAccountsDelete,
        `serviceaccounts:id:${req.params['id']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await deps.serviceAccounts.delete(
          req.auth!.orgId,
          req.params['id']!,
          req.auth!.userId,
        );
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // -- GET /api/serviceaccounts/:id/tokens --------------------------------
  router.get(
    '/:id/tokens',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.ServiceAccountsRead,
        `serviceaccounts:id:${req.params['id']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const saId = req.params['id']!;
        const sa = await deps.serviceAccounts.getById(req.auth!.orgId, saId);
        if (!sa) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'service account not found' },
          });
          return;
        }
        const tokens = await deps.apiKeys.listByServiceAccount(
          req.auth!.orgId,
          saId,
        );
        // Never leak the stored hash; expose only metadata.
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

  // -- POST /api/serviceaccounts/:id/tokens -------------------------------
  // Strict per-user 5/min cap (token-issue limiter) — see
  // `middleware/rate-limiter.ts`. Layered on top of the per-user 600/min
  // bucket mounted in `server.ts`.
  router.post(
    '/:id/tokens',
    tokenIssueRateLimiter,
    requirePermission((req) =>
      ac.eval(
        ACTIONS.ServiceAccountsWrite,
        `serviceaccounts:id:${req.params['id']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as {
          name?: string;
          secondsToLive?: number | null;
        };
        if (!body.name) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'name is required' },
          });
          return;
        }
        const issued = await deps.apiKeys.issueServiceAccountToken(
          req.auth!.orgId,
          req.params['id']!,
          {
            name: body.name,
            secondsToLive: body.secondsToLive,
          },
        );
        // Grafana response shape: { id, name, key }. Include expiration for
        // client UX — not present in stock Grafana response but harmless.
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

  // -- DELETE /api/serviceaccounts/:id/tokens/:tokenId --------------------
  router.delete(
    '/:id/tokens/:tokenId',
    requirePermission((req) =>
      ac.eval(
        ACTIONS.ServiceAccountsWrite,
        `serviceaccounts:id:${req.params['id']}`,
      ),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const token = await deps.apiKeys.getById(
          req.auth!.orgId,
          req.params['tokenId']!,
        );
        if (!token || token.serviceAccountId !== req.params['id']) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'token not found' },
          });
          return;
        }
        await deps.apiKeys.revoke(
          req.auth!.orgId,
          token.id,
          req.auth!.userId,
        );
        res.status(204).send();
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
