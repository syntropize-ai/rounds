/**
 * /api/org/* — current-org endpoints.
 *
 * "Current" org is resolved by the orgContext middleware → `req.auth.orgId`.
 * Mirrors Grafana's `/api/org/*` group (pkg/api/org.go / pkg/api/org_users.go,
 * read for semantics only). See docs/auth-perm-design/08-api-surface.md
 * §/api/org.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type {
  IPreferencesRepository,
} from '@agentic-obs/common';
import {
  ac,
  ACTIONS,
  ORG_ROLES,
  type OrgRole,
} from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { OrgService, OrgServiceError } from '../services/org-service.js';

export interface OrgRouterDeps {
  orgs: OrgService;
  ac: AccessControlService;
  preferences?: IPreferencesRepository;
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

export function createOrgRouter(deps: OrgRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // — GET /api/org ----------------------------------------------------------
  router.get(
    '/',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgsRead, `orgs:id:${req.auth!.orgId}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const org = await deps.orgs.getById(req.auth!.orgId);
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

  // — PUT /api/org ----------------------------------------------------------
  router.put(
    '/',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgsWrite, `orgs:id:${req.auth!.orgId}`),
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
        };
        await deps.orgs.update(req.auth!.orgId, patch, req.auth!.userId);
        res.json({ message: 'Organization updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/org/users ---------------------------------------------------
  router.get(
    '/users',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersRead, `orgs:id:${req.auth!.orgId}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const query =
          typeof req.query['query'] === 'string'
            ? (req.query['query'] as string)
            : undefined;
        const perpage = Number(req.query['perpage'] ?? 50);
        const page = Number(req.query['page'] ?? 1);
        const limit =
          Number.isFinite(perpage) && perpage > 0 ? Math.floor(perpage) : 50;
        const pageNum = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
        const result = await deps.orgs.listUsers(req.auth!.orgId, {
          query,
          limit,
          offset: (pageNum - 1) * limit,
        });
        // Shape matches Grafana's /api/org/users (items + pagination). The
        // admin Users page reads `items` + `totalCount`; returning a bare
        // array makes it render empty even when rows exist.
        res.json({
          totalCount: result.total,
          items: result.items.map((u) => ({
            orgId: u.orgId,
            userId: u.userId,
            email: u.email,
            name: u.name,
            login: u.login,
            role: u.role,
            isDisabled: false,
          })),
          page: pageNum,
          perPage: limit,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/org/users ---------------------------------------------------
  router.post(
    '/users',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersAdd, `orgs:id:${req.auth!.orgId}`),
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
          req.auth!.orgId,
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

  // — PATCH /api/org/users/:userId ------------------------------------------
  router.patch(
    '/users/:userId',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersWrite, `orgs:id:${req.auth!.orgId}`),
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
          req.auth!.orgId,
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

  // — DELETE /api/org/users/:userId -----------------------------------------
  router.delete(
    '/users/:userId',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgUsersRemove, `orgs:id:${req.auth!.orgId}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await deps.orgs.removeUser(
          req.auth!.orgId,
          req.params['userId']!,
          req.auth!.userId,
        );
        res.json({ message: 'User removed from organization' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/org/preferences ---------------------------------------------
  router.get(
    '/preferences',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgsPreferencesRead, `orgs:id:${req.auth!.orgId}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.preferences) {
        res.json({});
        return;
      }
      try {
        const prefs = await deps.preferences.findOrgPrefs(req.auth!.orgId);
        res.json({
          homeDashboardUid: prefs?.homeDashboardUid ?? null,
          timezone: prefs?.timezone ?? '',
          theme: prefs?.theme ?? '',
          weekStart: prefs?.weekStart ?? '',
          locale: prefs?.locale ?? '',
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PUT /api/org/preferences ---------------------------------------------
  router.put(
    '/preferences',
    requirePermission((req) =>
      ac.eval(ACTIONS.OrgsPreferencesWrite, `orgs:id:${req.auth!.orgId}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.preferences) {
        res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'preferences not configured',
          },
        });
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        await deps.preferences.upsert({
          orgId: req.auth!.orgId,
          homeDashboardUid: (body['homeDashboardUid'] as string | null) ?? null,
          timezone: (body['timezone'] as string | null) ?? null,
          theme: (body['theme'] as string | null) ?? null,
          weekStart: (body['weekStart'] as string | null) ?? null,
          locale: (body['locale'] as string | null) ?? null,
        });
        res.json({ message: 'Preferences updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
