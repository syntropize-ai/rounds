/**
 * /api/orgs/* — server-admin cross-org endpoints.
 *
 * Mirrors docs/auth-perm-design/08-api-surface.md §/api/orgs, which mirrors
 * Grafana's `pkg/api/api.go::RegisterRoutes` for `/api/orgs/*` (read for
 * semantics only, nothing copied).
 *
 * Every route is gated through `requirePermission` against the RBAC
 * catalog (ACTIONS.Orgs* / ACTIONS.OrgUsers*).
 */

import { Router } from 'express';
import type { Response } from 'express';
import { ac, ACTIONS, ORG_ROLES, type OrgRole } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { OrgService, OrgServiceError } from '../services/org-service.js';

export interface OrgsRouterDeps {
  orgs: OrgService;
  ac: AccessControlService;
}

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof OrgServiceError) {
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
} {
  const query =
    typeof req.query['query'] === 'string'
      ? (req.query['query'] as string)
      : undefined;
  const perpage = Number(req.query['perpage'] ?? 50);
  const page = Number(req.query['page'] ?? 1);
  const limit = Number.isFinite(perpage) && perpage > 0 ? Math.floor(perpage) : 50;
  const pageNum = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  return { query, limit, offset: (pageNum - 1) * limit };
}

export function createOrgsRouter(deps: OrgsRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // — GET /api/orgs ---------------------------------------------------------
  router.get(
    '/',
    requirePermission(ac.eval(ACTIONS.OrgsRead, 'orgs:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const opts = parseListOpts(req);
        const page = await deps.orgs.list(opts);
        // Shape matches /api/teams and /api/serviceaccounts (items +
        // pagination envelope). The admin Orgs page reads
        // `items`/`totalCount`; a bare array renders empty.
        res.json({
          totalCount: page.total,
          items: page.items.map((o) => ({
            id: o.id,
            name: o.name,
            version: o.version,
            created: o.created,
            updated: o.updated,
          })),
          page: Math.floor(opts.offset / opts.limit) + 1,
          perPage: opts.limit,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/orgs --------------------------------------------------------
  router.post(
    '/',
    requirePermission(ac.eval(ACTIONS.OrgsCreate)),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { name?: string };
        if (!body.name) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'name is required' },
          });
          return;
        }
        const org = await deps.orgs.create({
          name: body.name,
          createdBy: req.auth!.userId,
        });
        res.status(200).json({ orgId: org.id, message: 'Organization created' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/orgs/:id -----------------------------------------------------
  router.get(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgsRead, `orgs:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const org = await deps.orgs.getById(req.params['id']!);
        if (!org) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'organization not found' },
          });
          return;
        }
        res.json(org);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/orgs/name/:name ---------------------------------------------
  router.get(
    '/name/:name',
    requirePermission(ac.eval(ACTIONS.OrgsRead, 'orgs:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const org = await deps.orgs.getByName(req.params['name']!);
        if (!org) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'organization not found' },
          });
          return;
        }
        res.json(org);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PUT /api/orgs/:id -----------------------------------------------------
  router.put(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgsWrite, `orgs:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch = {
          name: body['name'] as string | undefined,
          address1: body['address1'] as string | null | undefined,
          address2: body['address2'] as string | null | undefined,
          city: body['city'] as string | null | undefined,
          state: body['state'] as string | null | undefined,
          zipCode: body['zipCode'] as string | null | undefined,
          country: body['country'] as string | null | undefined,
          billingEmail: body['billingEmail'] as string | null | undefined,
          expectedVersion: typeof body['version'] === 'number' ? (body['version'] as number) : undefined,
        };
        const updated = await deps.orgs.update(
          req.params['id']!,
          patch,
          req.auth!.userId,
        );
        res.json({ message: 'Organization updated', orgId: updated.id });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — DELETE /api/orgs/:id --------------------------------------------------
  router.delete(
    '/:id',
    requirePermission(ac.eval(ACTIONS.OrgsDelete)),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await deps.orgs.delete(req.params['id']!, req.auth!.userId);
        res.json({ message: 'Organization deleted' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/orgs/:id/users ----------------------------------------------
  router.get(
    '/:id/users',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersRead, `orgs:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const opts = parseListOpts(req);
        const page = await deps.orgs.listUsers(req.params['id']!, opts);
        res.json({
          totalCount: page.total,
          items: page.items.map((u) => ({
            orgId: u.orgId,
            userId: u.userId,
            email: u.email,
            name: u.name,
            login: u.login,
            role: u.role,
            isDisabled: false,
          })),
          page: Math.floor(opts.offset / opts.limit) + 1,
          perPage: opts.limit,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/orgs/:id/users ----------------------------------------------
  router.post(
    '/:id/users',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersAdd, `orgs:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as {
          loginOrEmail?: string;
          role?: string;
        };
        if (!body.loginOrEmail) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'loginOrEmail is required' },
          });
          return;
        }
        if (!body.role || !(ORG_ROLES as readonly string[]).includes(body.role)) {
          res.status(400).json({
            message: `role must be one of: ${ORG_ROLES.join(', ')}`,
          });
          return;
        }
        const membership = await deps.orgs.addUserByLoginOrEmail(
          req.params['id']!,
          body.loginOrEmail,
          body.role as OrgRole,
          req.auth!.userId,
        );
        res.status(200).json({
          message: 'User added to organization',
          userId: membership.userId,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PATCH /api/orgs/:id/users/:userId -------------------------------------
  router.patch(
    '/:id/users/:userId',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersWrite, `orgs:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { role?: string };
        if (!body.role || !(ORG_ROLES as readonly string[]).includes(body.role)) {
          res.status(400).json({
            message: `role must be one of: ${ORG_ROLES.join(', ')}`,
          });
          return;
        }
        await deps.orgs.updateUserRole(
          req.params['id']!,
          req.params['userId']!,
          body.role as OrgRole,
          req.auth!.userId,
        );
        res.json({ message: 'Organization user updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — DELETE /api/orgs/:id/users/:userId ------------------------------------
  router.delete(
    '/:id/users/:userId',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersRemove, `orgs:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await deps.orgs.removeUser(
          req.params['id']!,
          req.params['userId']!,
          req.auth!.userId,
        );
        res.json({ message: 'User removed from organization' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
