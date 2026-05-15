/**
 * POST /api/metrics/save-as-dashboard — finalize an inline-chart bubble
 * into a persistent dashboard panel.
 *
 * Companion to `POST /api/metrics/save-as-dashboard/preview` which surfaces
 * "this looks similar to an existing dashboard" suggestions so the user
 * can append a panel instead of creating a new dashboard.
 *
 * Similarity heuristic = normalized-PromQL Jaccard token overlap. Threshold
 * 60%. Deliberately simple — the surface is "throwaway exploration" and
 * the user always sees the title before committing.
 *
 * Auth: requires `dashboards:write` on the target (existing dashboard) or
 * `dashboards:create` on `folders:*` (new dashboard). Audit rows are
 * dashboard.create or dashboard.update.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import {
  ac,
  ACTIONS,
  AuditAction,
  type ChartMetricKind,
  type PanelConfig,
  type PanelVisualization,
} from '@agentic-obs/common';
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import { getOrgId } from '../middleware/workspace-context.js';

export interface SaveAsDashboardRouterDeps {
  dashboardStore: IGatewayDashboardStore;
  ac: AccessControlSurface;
  audit: AuditWriter;
}

const SIMILARITY_THRESHOLD = 0.6;

/** Visualization choice based on metric kind. Mirrors the chart bubble. */
function pickVisualization(kind: ChartMetricKind): PanelVisualization {
  // All kinds map to time_series in v1 — same widget the chart bubble uses.
  // Future: stat for gauge, heatmap for latency histograms, etc.
  void kind;
  return 'time_series';
}

/**
 * Normalize a PromQL expression for similarity hashing. Strips whitespace,
 * lowercases, and sorts label-selector pairs inside `{…}` so e.g.
 * `{job="api", env="prod"}` and `{env="prod",job="api"}` hash identically.
 */
export function normalizePromQL(query: string): string {
  const lower = query.toLowerCase().replace(/\s+/g, '');
  // Sort label selectors inside braces.
  return lower.replace(/\{([^}]+)\}/g, (_match, inner: string) => {
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
    parts.sort();
    return `{${parts.join(',')}}`;
  });
}

/** Tokenize a normalized PromQL string into a set of meaningful tokens. */
function tokens(normalized: string): Set<string> {
  // Split on non-word chars; keep alpha/numeric chunks length ≥ 2 to
  // avoid one-letter tokens dominating short queries.
  const ts = normalized
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
  return new Set(ts);
}

/** Jaccard token overlap on normalized PromQL — 0..1. */
export function querySimilarity(a: string, b: string): number {
  const ta = tokens(normalizePromQL(a));
  const tb = tokens(normalizePromQL(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface SaveBody {
  title?: unknown;
  query?: unknown;
  metricKind?: unknown;
  datasourceId?: unknown;
  addToExistingDashboardId?: unknown;
}

interface PreviewBody {
  query?: unknown;
}

function buildPanel(args: {
  title: string;
  query: string;
  metricKind: ChartMetricKind;
  datasourceId: string;
  row: number;
}): PanelConfig {
  return {
    id: randomUUID(),
    title: args.title,
    description: '',
    queries: [
      {
        refId: 'A',
        expr: args.query,
        datasourceId: args.datasourceId,
      },
    ],
    visualization: pickVisualization(args.metricKind),
    row: args.row,
    col: 0,
    width: 12,
    height: 8,
  };
}

export function createMetricsSaveAsDashboardRouter(
  deps: SaveAsDashboardRouterDeps,
): Router {
  const router = Router();
  router.use(authMiddleware);

  // POST /save-as-dashboard/preview — similarity hints (no mutation).
  router.post('/save-as-dashboard/preview', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
        return;
      }
      const body = req.body as PreviewBody;
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'query is required' } });
        return;
      }

      const orgId = auth.orgId || getOrgId(req);
      const all = await deps.dashboardStore.findAll();
      const matches: Array<{ dashboardId: string; title: string; similarityPct: number }> = [];

      for (const d of all) {
        if (d.workspaceId !== orgId) continue;
        let best = 0;
        for (const panel of d.panels) {
          const exprs: string[] = [];
          if (panel.query) exprs.push(panel.query);
          for (const q of panel.queries ?? []) exprs.push(q.expr);
          for (const expr of exprs) {
            const sim = querySimilarity(query, expr);
            if (sim > best) best = sim;
          }
        }
        if (best >= SIMILARITY_THRESHOLD) {
          matches.push({
            dashboardId: d.id,
            title: d.title,
            similarityPct: Math.round(best * 100),
          });
        }
      }

      matches.sort((a, b) => b.similarityPct - a.similarityPct);
      res.json({ matches: matches.slice(0, 5) });
    } catch (err) {
      next(err);
    }
  });

  // POST /save-as-dashboard — create or append.
  router.post('/save-as-dashboard', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
        return;
      }
      const body = req.body as SaveBody;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      const datasourceId = typeof body.datasourceId === 'string' ? body.datasourceId.trim() : '';
      const metricKindInput = typeof body.metricKind === 'string' ? body.metricKind : '';
      const validKinds: ChartMetricKind[] = ['latency', 'counter', 'gauge', 'errors'];
      const metricKind = (validKinds as string[]).includes(metricKindInput)
        ? (metricKindInput as ChartMetricKind)
        : 'gauge';
      const addToExistingDashboardId =
        typeof body.addToExistingDashboardId === 'string' && body.addToExistingDashboardId.trim()
          ? body.addToExistingDashboardId.trim()
          : undefined;

      if (!title || !query || !datasourceId) {
        res.status(400).json({
          error: { code: 'INVALID_INPUT', message: 'title, query, and datasourceId are required' },
        });
        return;
      }

      const orgId = auth.orgId || getOrgId(req);

      if (addToExistingDashboardId) {
        // -- Append to existing dashboard. --
        const existing = await deps.dashboardStore.findById(addToExistingDashboardId);
        if (!existing || existing.workspaceId !== orgId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dashboard not found' } });
          return;
        }
        const allowed = await deps.ac.evaluate(
          auth,
          ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${existing.id}`),
        );
        if (!allowed) {
          res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No write permission' } });
          return;
        }

        const lastRow = existing.panels.reduce(
          (acc, p) => Math.max(acc, p.row + p.height),
          0,
        );
        const panel = buildPanel({ title, query, metricKind, datasourceId, row: lastRow });
        const updated = await deps.dashboardStore.updatePanels(existing.id, [...existing.panels, panel]);
        if (!updated) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dashboard not found' } });
          return;
        }

        void deps.audit.log({
          action: AuditAction.DashboardUpdate,
          actorType: 'user',
          actorId: auth.userId,
          orgId,
          targetType: 'dashboard',
          targetId: existing.id,
          targetName: existing.title,
          outcome: 'success',
          metadata: { source: 'save_as_dashboard', panelId: panel.id },
        });

        res.status(200).json({
          dashboardId: existing.id,
          panelId: panel.id,
          url: `/dashboards/${existing.id}`,
        });
        return;
      }

      // -- Create new dashboard. --
      const allowed = await deps.ac.evaluate(
        auth,
        ac.eval(ACTIONS.DashboardsCreate, 'folders:*'),
      );
      if (!allowed) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No create permission' } });
        return;
      }

      const dashboard = await deps.dashboardStore.create({
        title,
        description: '',
        prompt: query,
        userId: auth.userId,
        datasourceIds: [datasourceId],
        useExistingMetrics: true,
        workspaceId: orgId,
        source: 'api',
      });
      const panel = buildPanel({ title, query, metricKind, datasourceId, row: 0 });
      await deps.dashboardStore.updatePanels(dashboard.id, [panel]);

      void deps.audit.log({
        action: AuditAction.DashboardCreate,
        actorType: 'user',
        actorId: auth.userId,
        orgId,
        targetType: 'dashboard',
        targetId: dashboard.id,
        targetName: dashboard.title,
        outcome: 'success',
        metadata: { source: 'save_as_dashboard' },
      });

      res.status(201).json({
        dashboardId: dashboard.id,
        panelId: panel.id,
        url: `/dashboards/${dashboard.id}`,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
