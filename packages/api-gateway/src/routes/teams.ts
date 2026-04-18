/**
 * /api/teams/* — team CRUD + membership + team preferences.
 *
 * Mirrors docs/auth-perm-design/08-api-surface.md §/api/teams (which itself
 * mirrors Grafana's `pkg/api/api.go` registrations for `/api/teams/*`).
 *
 * Every mutation is gated by `requirePermission`:
 *   - teams:create   → POST /api/teams
 *   - teams:read     → GET  /api/teams/...  (including list-search)
 *   - teams:write    → PUT/DELETE /api/teams/:id (scope `teams:id:<id>`)
 *   - teams.permissions:write → member mutations
 *
 * Every handler reads `req.auth.orgId` as the authoritative org — the caller's
 * org-context middleware has already validated membership (or rejected with
 * 403). Handlers do NOT accept an `orgId` from the body / query.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import { TEAM_MEMBER_PERMISSION_MEMBER } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlService } from '../services/accesscontrol-service.js';
import { TeamService, TeamServiceError } from '../services/team-service.js';

export interface TeamsRouterDeps {
  teams: TeamService;
  ac: AccessControlService;
}

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof TeamServiceError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }
  res.status(500).json({
    message: err instanceof Error ? err.message : 'internal error',
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

function parseMemberPermission(v: unknown): 0 | 4 | null {
  if (v === 0 || v === '0') return 0;
  if (v === 4 || v === '4') return 4;
  return null;
}

export function createTeamsRouter(deps: TeamsRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // — GET /api/teams/search ------------------------------------------------
  router.get(
    '/search',
    requirePermission(ac.eval(ACTIONS.TeamsRead, 'teams:*')),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const opts = parseListOpts(req);
        const page = await deps.teams.list(req.auth!.orgId, opts);
        // Shape matches grafana's /api/teams/search (teams + pagination).
        res.json({
          totalCount: page.total,
          teams: page.items.map((t) => ({
            id: t.id,
            orgId: t.orgId,
            name: t.name,
            email: t.email,
            external: t.external,
            created: t.created,
            updated: t.updated,
          })),
          page: Math.floor(opts.offset / opts.limit) + 1,
          perPage: opts.limit,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/teams ------------------------------------------------------
  router.post(
    '/',
    requirePermission(ac.eval(ACTIONS.TeamsCreate)),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { name?: string; email?: string };
        if (!body.name || typeof body.name !== 'string') {
          res.status(400).json({ message: 'name is required' });
          return;
        }
        const team = await deps.teams.create(req.auth!.orgId, {
          name: body.name,
          email: body.email ?? null,
        });
        res.status(200).json({
          teamId: team.id,
          message: 'Team created',
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/teams/:id ---------------------------------------------------
  router.get(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsRead, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const team = await deps.teams.getById(req.auth!.orgId, req.params['id']!);
        if (!team) {
          res.status(404).json({ message: 'team not found' });
          return;
        }
        res.json({
          id: team.id,
          orgId: team.orgId,
          name: team.name,
          email: team.email,
          external: team.external,
          created: team.created,
          updated: team.updated,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PUT /api/teams/:id ---------------------------------------------------
  router.put(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsWrite, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { name?: string; email?: string };
        await deps.teams.update(
          req.auth!.orgId,
          req.params['id']!,
          { name: body.name, email: body.email },
          req.auth!.userId,
        );
        res.json({ message: 'Team updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — DELETE /api/teams/:id ------------------------------------------------
  router.delete(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsDelete, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await deps.teams.delete(
          req.auth!.orgId,
          req.params['id']!,
          req.auth!.userId,
        );
        res.json({ message: 'Team deleted' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/teams/:id/members ------------------------------------------
  router.get(
    '/:id/members',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsPermissionsRead, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const members = await deps.teams.listMembers(
          req.auth!.orgId,
          req.params['id']!,
        );
        res.json(
          members.map((m) => ({
            orgId: m.orgId,
            teamId: m.teamId,
            userId: m.userId,
            permission: m.permission,
            external: m.external,
            created: m.created,
            updated: m.updated,
          })),
        );
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — POST /api/teams/:id/members -----------------------------------------
  router.post(
    '/:id/members',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsPermissionsWrite, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { userId?: string; permission?: unknown };
        if (!body.userId || typeof body.userId !== 'string') {
          res.status(400).json({ message: 'userId is required' });
          return;
        }
        const perm =
          body.permission === undefined
            ? TEAM_MEMBER_PERMISSION_MEMBER
            : parseMemberPermission(body.permission);
        if (perm === null) {
          res.status(400).json({ message: 'permission must be 0 or 4' });
          return;
        }
        await deps.teams.addMember(
          req.auth!.orgId,
          req.params['id']!,
          body.userId,
          perm,
          { actorId: req.auth!.userId },
        );
        res.json({ message: 'Member added to team' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PUT /api/teams/:id/members/:userId ----------------------------------
  router.put(
    '/:id/members/:userId',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsPermissionsWrite, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { permission?: unknown };
        const perm = parseMemberPermission(body.permission);
        if (perm === null) {
          res.status(400).json({ message: 'permission must be 0 or 4' });
          return;
        }
        await deps.teams.updateMember(
          req.auth!.orgId,
          req.params['id']!,
          req.params['userId']!,
          perm,
          req.auth!.userId,
        );
        res.json({ message: 'Team member updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — DELETE /api/teams/:id/members/:userId -------------------------------
  router.delete(
    '/:id/members/:userId',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsPermissionsWrite, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await deps.teams.removeMember(
          req.auth!.orgId,
          req.params['id']!,
          req.params['userId']!,
          { actorId: req.auth!.userId },
        );
        res.json({ message: 'Team member removed' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — GET /api/teams/:id/preferences --------------------------------------
  router.get(
    '/:id/preferences',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsRead, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const prefs = await deps.teams.getTeamPreferences(
          req.auth!.orgId,
          req.params['id']!,
        );
        // Grafana returns an empty preferences object when no row exists — keep
        // parity so UIs don't have to null-check.
        if (!prefs) {
          res.json({
            homeDashboardUid: null,
            timezone: '',
            weekStart: '',
            theme: '',
            locale: '',
          });
          return;
        }
        res.json({
          homeDashboardUid: prefs.homeDashboardUid,
          timezone: prefs.timezone ?? '',
          weekStart: prefs.weekStart ?? '',
          theme: prefs.theme ?? '',
          locale: prefs.locale ?? '',
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // — PUT /api/teams/:id/preferences --------------------------------------
  router.put(
    '/:id/preferences',
    requirePermission((req) =>
      ac.eval(ACTIONS.TeamsWrite, `teams:id:${req.params['id']}`),
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        await deps.teams.setTeamPreferences(req.auth!.orgId, req.params['id']!, {
          homeDashboardUid:
            typeof body['homeDashboardUid'] === 'string'
              ? (body['homeDashboardUid'] as string)
              : undefined,
          timezone:
            typeof body['timezone'] === 'string'
              ? (body['timezone'] as string)
              : undefined,
          weekStart:
            typeof body['weekStart'] === 'string'
              ? (body['weekStart'] as string)
              : undefined,
          theme:
            typeof body['theme'] === 'string'
              ? (body['theme'] as string)
              : undefined,
          locale:
            typeof body['locale'] === 'string'
              ? (body['locale'] as string)
              : undefined,
        });
        res.json({ message: 'Preferences updated' });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
