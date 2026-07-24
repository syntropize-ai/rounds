/**
 * `/api/admin/panel-events/*` — server-admin-only read API over the
 * `panel_events` table. Bootstraps the offline lint-rule analysis loop:
 * for now the only endpoint exposes the same `aggregateBySignature` shape
 * the repository returns; future endpoints (top abandoned signatures,
 * per-org churn rate, …) hang off the same router.
 */

import { Router, type Response, type Router as ExpressRouter } from 'express';
import type { IPanelEventRepository } from '@agentic-obs/data-layer';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getOrgId } from '../middleware/workspace-context.js';
import { asyncHandler } from '../middleware/async-handler.js';

export interface AdminPanelEventsDeps {
  panelEvents: IPanelEventRepository;
}

function requireServerAdmin(req: AuthenticatedRequest, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
    return false;
  }
  if (!req.auth.isServerAdmin) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'server admin required' } });
    return false;
  }
  return true;
}

function resolveOrgId(req: AuthenticatedRequest): string {
  return req.auth?.orgId ?? getOrgId(req);
}

export function createAdminPanelEventsRouter(deps: AdminPanelEventsDeps): ExpressRouter {
  const router = Router();

  router.get('/aggregate', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!requireServerAdmin(req, res)) return;
    const orgId = resolveOrgId(req);
    const sinceRaw = typeof req.query['since'] === 'string' ? req.query['since'] : undefined;
    const eventTypesRaw =
      typeof req.query['eventTypes'] === 'string' ? req.query['eventTypes'] : undefined;
    const eventTypes = eventTypesRaw
      ? eventTypesRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

    // Defensive ISO validation — repositories pass `since` straight into a
    // text comparison; if the caller sends garbage we'd return zero rows
    // silently. Surface that as 400 instead.
    if (sinceRaw !== undefined && Number.isNaN(Date.parse(sinceRaw))) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'since must be an ISO-8601 timestamp' } });
      return;
    }

    const opts: { since?: string; eventTypes?: string[] } = {};
    if (sinceRaw) opts.since = sinceRaw;
    if (eventTypes) opts.eventTypes = eventTypes;

    const rows = await deps.panelEvents.aggregateBySignature(orgId, opts);
    res.json({ rows });
  }));

  return router;
}
