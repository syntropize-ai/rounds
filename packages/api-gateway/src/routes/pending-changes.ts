/**
 * Pending-changes routes — first-class persisted agent dashboard proposals.
 *
 * Mutation handlers in agent-core write rows to `pending_changes`; this
 * router exposes the read/accept/reject surface that the dashboard UI uses.
 * Permissions are dashboard-folder scoped (read for list, write for
 * accept/reject) and resolved through the standard accessControl surface.
 *
 * Accept applies `after_json` to the live dashboard via the dashboard store
 * and records a panel_events row so the offline lint-mining pipeline sees
 * the change. Reject just stamps the row's status.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction, Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { Dashboard, DashboardSseEvent, PanelConfig, DashboardVariable } from '@agentic-obs/common';
import type {
  IGatewayDashboardStore,
  IChatSessionEventRepository,
  IPendingChangeRepository,
  IPanelEventRepository,
  PendingChange,
} from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { getOrgId } from '../middleware/workspace-context.js';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { SessionEventBus } from '../services/session-event-bus.js';
import { asyncHandler } from '../middleware/async-handler.js';

const log = createLogger('pending-changes-routes');
const PANEL_VISUALIZATION_VALUES = new Set([
  'time_series',
  'stat',
  'table',
  'gauge',
  'bar',
  'bar_gauge',
  'heatmap',
  'pie',
  'histogram',
  'status_timeline',
]);

class InvalidPendingChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPendingChangeError';
  }
}

export interface PendingChangesRouterDeps {
  pendingChanges: IPendingChangeRepository;
  dashboards: IGatewayDashboardStore;
  accessControl: AccessControlSurface;
  /** Optional panel-events sink — when wired, accept emits a row so the
   *  offline lint-mining pipeline sees agent-applied changes. */
  panelEvents?: IPanelEventRepository;
  chatSessionEvents?: IChatSessionEventRepository;
  sessionEventBus?: SessionEventBus;
}

function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

function actorId(req: Request): string {
  const a = (req as AuthenticatedRequest).auth;
  return a?.userId ?? 'anonymous';
}

function assertValidPanel(panel: PanelConfig): void {
  if (typeof panel.id !== 'string' || panel.id.trim() === '') {
    throw new InvalidPendingChangeError('panel id is required');
  }
  if (typeof panel.title !== 'string' || panel.title.trim() === '') {
    throw new InvalidPendingChangeError(`panel ${panel.id} has invalid title`);
  }
  if (
    typeof panel.visualization !== 'string' ||
    !PANEL_VISUALIZATION_VALUES.has(panel.visualization)
  ) {
    throw new InvalidPendingChangeError(`panel ${panel.id} has invalid visualization`);
  }
}

/**
 * Apply a single resolved change to the live dashboard. Returns the patched
 * dashboard or null if the underlying dashboard vanished mid-flight.
 *
 * after_json shape per changeKind (matching the handler write path):
 *   modify_panel  → full PanelConfig (merged before+patch)
 *   add_panel     → PanelConfig
 *   remove_panel  → { panelId }
 *   set_title     → { title, description }
 *   add_variable  → DashboardVariable
 */
async function applyChange(
  store: IGatewayDashboardStore,
  change: PendingChange,
): Promise<Dashboard | null> {
  const dash = await store.findById(change.dashboardId);
  if (!dash) return null;
  switch (change.changeKind) {
    case 'modify_panel': {
      const after = change.afterJson as PanelConfig;
      const panels = dash.panels.map((p) => (p.id === after.id ? { ...p, ...after } : p));
      for (const panel of panels) assertValidPanel(panel);
      return (await store.updatePanels(change.dashboardId, panels)) ?? null;
    }
    case 'add_panel': {
      const after = change.afterJson as PanelConfig;
      // If the row stored a config without an id (the handler passed the raw
      // proposed panel), mint one at apply time.
      const panel: PanelConfig = after.id ? after : { ...after, id: cryptoRandomId() };
      assertValidPanel(panel);
      return (await store.updatePanels(change.dashboardId, [...dash.panels, panel])) ?? null;
    }
    case 'remove_panel': {
      const target = (change.afterJson as { panelId?: string } | null)?.panelId
        ?? change.panelId
        ?? '';
      const filtered = dash.panels.filter((p) => p.id !== target);
      return (await store.updatePanels(change.dashboardId, filtered)) ?? null;
    }
    case 'set_title': {
      const after = change.afterJson as { title: string; description?: string };
      return (await store.update(change.dashboardId, {
        title: after.title,
        ...(after.description !== undefined ? { description: after.description } : {}),
      })) ?? null;
    }
    case 'add_variable': {
      const v = change.afterJson as DashboardVariable;
      const variables = [...(dash.variables ?? []), v];
      return (await store.updateVariables(change.dashboardId, variables)) ?? null;
    }
    default:
      throw new Error(`[pending-changes] unknown changeKind: ${String(change.changeKind)}`);
  }
}

function cryptoRandomId(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (globalThis.crypto as { randomUUID(): string }).randomUUID();
}

function sessionIdFromProposedBy(proposedBy: string | null | undefined): string | null {
  const prefix = 'agent:';
  if (!proposedBy?.startsWith(prefix)) return null;
  const sessionId = proposedBy.slice(prefix.length).trim();
  return sessionId ? sessionId : null;
}

async function emitPendingChangeResolved(
  deps: PendingChangesRouterDeps,
  change: PendingChange,
  status: 'accepted' | 'rejected',
): Promise<void> {
  const sessionId = sessionIdFromProposedBy(change.proposedBy);
  if (!sessionId || !deps.chatSessionEvents) return;

  const event: DashboardSseEvent = {
    type: 'pending_change_resolved',
    id: change.id,
    dashboardId: change.dashboardId,
    status,
  };

  try {
    const saved = await deps.chatSessionEvents.appendNext({
      id: randomUUID(),
      sessionId,
      kind: event.type,
      payload: event as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    deps.sessionEventBus?.publish(sessionId, saved.seq, event);
  } catch (err) {
    log.warn(
      {
        changeId: change.id,
        sessionId,
        status,
        err: err instanceof Error ? err.message : String(err),
      },
      'pending_change_resolved emit failed (swallowed)',
    );
  }
}

export function createPendingChangesRouter(deps: PendingChangesRouterDeps): ExpressRouter {
  const router = Router();
  const requirePermission = createRequirePermission(deps.accessControl);
  router.use(authMiddleware);

  // GET /api/dashboards/:id/pending-changes?status=pending
  router.get(
    '/dashboards/:id/pending-changes',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['id']}`)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const orgId = resolveOrgId(req);
        const statusQ = typeof req.query['status'] === 'string' ? req.query['status'] : 'pending';
        const status =
          statusQ === 'pending' || statusQ === 'accepted' || statusQ === 'rejected' || statusQ === 'expired'
            ? statusQ
            : 'pending';
        const changes = await deps.pendingChanges.listByDashboard(orgId, id, { status });
        res.json({ changes });
      } catch (err) {
        next(err);
      }
    }),
  );

  // GET /api/pending-changes/count
  // Returns total + per-dashboard counts for the global nav badge. Caller's
  // read permission is checked per-dashboard via filterByPermission so the
  // count reflects only dashboards the user can see.
  router.get('/pending-changes/count', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = resolveOrgId(req);
      const grouped = await deps.pendingChanges.countByOrgGrouped(orgId, 'pending');
      const identity = (req as AuthenticatedRequest).auth;
      // Resolve titles + filter by read permission. We do this in-memory; the
      // grouped count is bounded by pending rows so this is cheap.
      const ids = grouped.map((g) => g.dashboardId);
      const dashboards = await Promise.all(ids.map((dId) => deps.dashboards.findById(dId)));
      const visibleByDashboard: Array<{
        dashboardId: string;
        dashboardTitle: string;
        count: number;
        changes: Array<{ id: string; panelId: string | null; summary: string; changeKind: string }>;
      }> = [];
      let total = 0;
      for (let i = 0; i < grouped.length; i++) {
        const dId = grouped[i]!.dashboardId;
        const dash = dashboards[i];
        if (!dash) continue;
        if (identity) {
          const allowed = await deps.accessControl.evaluate(
            identity,
            ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${dId}`),
          );
          if (!allowed) continue;
        }
        // Fetch the actual changes for the dropdown listing (bounded by pending count).
        const changes = await deps.pendingChanges.listByDashboard(orgId, dId, { status: 'pending' });
        visibleByDashboard.push({
          dashboardId: dId,
          dashboardTitle: dash.title,
          count: grouped[i]!.count,
          changes: changes.map((c) => ({
            id: c.id,
            panelId: c.panelId,
            summary: c.summary,
            changeKind: c.changeKind,
          })),
        });
        total += grouped[i]!.count;
      }
      res.json({ count: total, byDashboard: visibleByDashboard });
    } catch (err) {
      next(err);
    }
  }));

  // POST /api/dashboards/:id/pending-changes/:changeId/accept
  router.post(
    '/dashboards/:id/pending-changes/:changeId/accept',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const changeId = req.params['changeId'] ?? '';
        const orgId = resolveOrgId(req);
        const row = await deps.pendingChanges.getById(orgId, changeId);
        if (!row || row.dashboardId !== id) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending change not found' } });
          return;
        }
        if (row.status !== 'pending') {
          res.status(409).json({ error: { code: 'ALREADY_RESOLVED', message: `Change is ${row.status}` } });
          return;
        }
        try {
          const updated = await applyChange(deps.dashboards, row);
          if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dashboard not found' } });
            return;
          }
        } catch (err) {
          log.error(
            { changeId, dashboardId: id, err: err instanceof Error ? err.message : String(err) },
            'apply pending change failed',
          );
          res.status(err instanceof InvalidPendingChangeError ? 400 : 500).json({
            error: {
              code: err instanceof InvalidPendingChangeError ? 'INVALID_PENDING_CHANGE' : 'APPLY_FAILED',
              message: err instanceof Error ? err.message : 'apply failed',
            },
          });
          return;
        }
        const resolved = await deps.pendingChanges.resolve(orgId, changeId, 'accepted', actorId(req));
        // Fire-and-forget panel_events emission for the lint-mining pipeline.
        if (deps.panelEvents && row.panelId) {
          const eventType: 'created' | 'edited' | 'deleted' =
            row.changeKind === 'add_panel'
              ? 'created'
              : row.changeKind === 'remove_panel'
                ? 'deleted'
                : 'edited';
          Promise.resolve()
            .then(() =>
              deps.panelEvents!.record({
                orgId,
                dashboardId: id,
                panelId: row.panelId!,
                eventType,
                panelSnapshot: row.afterJson ?? null,
                querySignature: null,
                vizType: null,
                aiGenerated: true,
                actorId: actorId(req),
                sessionId: null,
              }),
            )
            .catch((err) => log.warn({ err }, 'panel_events emit on accept failed (swallowed)'));
        }
        await emitPendingChangeResolved(deps, row, 'accepted');
        res.json({ ok: true, applied: resolved });
      } catch (err) {
        next(err);
      }
    }),
  );

  // POST /api/dashboards/:id/pending-changes/:changeId/reject
  router.post(
    '/dashboards/:id/pending-changes/:changeId/reject',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const changeId = req.params['changeId'] ?? '';
        const orgId = resolveOrgId(req);
        const row = await deps.pendingChanges.getById(orgId, changeId);
        if (!row || row.dashboardId !== id) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending change not found' } });
          return;
        }
        if (row.status !== 'pending') {
          res.status(409).json({ error: { code: 'ALREADY_RESOLVED', message: `Change is ${row.status}` } });
          return;
        }
        const resolved = await deps.pendingChanges.resolve(orgId, changeId, 'rejected', actorId(req));
        await emitPendingChangeResolved(deps, row, 'rejected');
        res.json({ ok: true, resolved });
      } catch (err) {
        next(err);
      }
    }),
  );

  // POST /api/dashboards/:id/pending-changes/accept-all
  router.post(
    '/dashboards/:id/pending-changes/accept-all',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const orgId = resolveOrgId(req);
        const body = (req.body ?? {}) as { ids?: string[] };
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (ids.length === 0) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'ids is required' } });
          return;
        }
        const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
        for (const changeId of ids) {
          const row = await deps.pendingChanges.getById(orgId, changeId);
          if (!row || row.dashboardId !== id) {
            results.push({ id: changeId, ok: false, reason: 'not_found' });
            continue;
          }
          if (row.status !== 'pending') {
            results.push({ id: changeId, ok: false, reason: row.status });
            continue;
          }
          try {
            const updated = await applyChange(deps.dashboards, row);
            if (!updated) {
              results.push({ id: changeId, ok: false, reason: 'dashboard_not_found' });
              continue;
            }
            await deps.pendingChanges.resolve(orgId, changeId, 'accepted', actorId(req));
            await emitPendingChangeResolved(deps, row, 'accepted');
            results.push({ id: changeId, ok: true });
          } catch (err) {
            results.push({
              id: changeId,
              ok: false,
              reason: err instanceof Error ? err.message : 'apply_failed',
            });
          }
        }
        res.json({ results });
      } catch (err) {
        next(err);
      }
    }),
  );

  // POST /api/dashboards/:id/pending-changes/reject-all
  router.post(
    '/dashboards/:id/pending-changes/reject-all',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const orgId = resolveOrgId(req);
        const body = (req.body ?? {}) as { ids?: string[] };
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (ids.length === 0) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'ids is required' } });
          return;
        }
        const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
        for (const changeId of ids) {
          const row = await deps.pendingChanges.getById(orgId, changeId);
          if (!row || row.dashboardId !== id) {
            results.push({ id: changeId, ok: false, reason: 'not_found' });
            continue;
          }
          if (row.status !== 'pending') {
            results.push({ id: changeId, ok: false, reason: row.status });
            continue;
          }
          await deps.pendingChanges.resolve(orgId, changeId, 'rejected', actorId(req));
          await emitPendingChangeResolved(deps, row, 'rejected');
          results.push({ id: changeId, ok: true });
        }
        res.json({ results });
      } catch (err) {
        next(err);
      }
    }),
  );

  return router;
}
