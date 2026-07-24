// Quality meta-dashboard - GET /api/meta/quality
// Aggregates platform quality metrics: adoption rate, investigation cost,
// evidence completeness, and daily trend data.

import { Router } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer';
import { asyncHandler } from '../middleware/async-handler.js';

// -- Types

export interface DailyTrend {
  /** YYYY-MM-DD */
  date: string;
  investigations: number;
  avgDurationMs: number;
}

export interface WeeklyTrend {
  /** ISO week start date (Monday) */
  weekStart: string;
  investigations: number;
  avgDurationMs: number;
}

export interface QualityMetrics {
  totalInvestigations: number;
  adoptionRate: number;
  avgInvestigationDurationMs: number;
  avgTokensPerInvestigation: number;
  avgQueriesPerInvestigation: number;
  evidenceCompleteness: number;
  proactiveHitRate: number;
  dailyTrend: DailyTrend[];
  weeklyTrend: WeeklyTrend[];
  computedAt: string;
}

// -- Helpers

function toYMD(iso: string): string {
  return iso.slice(0, 10); // "YYYY-MM-DD"
}

/** Return the ISO date of the Monday of the week containing `date`. */
function toWeekStart(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // days to subtract to reach Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// -- Computation

export async function computeQualityMetrics(
  investigationStore: IGatewayInvestigationStore,
  feedStoreInstance: IGatewayFeedStore,
  orgId: string,
): Promise<QualityMetrics> {
  // Investigation.workspaceId is the legacy field name for what is now
  // the org id (see data-layer types). Filter by it to scope to this org.
  const investigations = (await investigationStore.findAll())
    .filter((inv) => inv.workspaceId === orgId);
  const totalInvestigations = investigations.length;

  // -- adoption rate
  const feedStats = await feedStoreInstance.getStats({ tenantId: orgId });
  const positive
    = (feedStats.byVerdict['useful'] ?? 0)
      + (feedStats.byVerdict['root_cause_correct'] ?? 0);
  const adoptionRate
    = feedStats.withFeedback > 0 ? positive / feedStats.withFeedback : 0;

  // -- Investigation duration
  const completed = investigations.filter((i) => i.status === 'completed');
  const durations = completed.map(
    (i) => new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime(),
  );

  const avgInvestigationDurationMs
    = durations.length > 0
      ? durations.reduce((s, d) => s + d, 0) / durations.length
      : 0;

  // -- token / query cost
  let totalTokens = 0;
  let totalQueries = 0;
  let invWithCost = 0;

  for (const inv of investigations) {
    const stepTokens = inv.plan.steps.reduce(
      (s, step) => s + (step.cost?.tokens ?? 0),
      0,
    );
    const stepQueries = inv.plan.steps.reduce(
      (s, step) => s + (step.cost?.queries ?? 0),
      0,
    );

    if (stepTokens > 0 || stepQueries > 0) {
      totalTokens += stepTokens;
      totalQueries += stepQueries;
      invWithCost++;
    }
  }

  const avgTokensPerInvestigation = invWithCost > 0 ? totalTokens / invWithCost : 0;
  const avgQueriesPerInvestigation = invWithCost > 0 ? totalQueries / invWithCost : 0;

  // -- proactive hit rate
  const proactiveHitRate = feedStats.proactiveHitRate;

  // -- evidence completeness
  const completenessRatios: number[] = [];
  for (const inv of investigations) {
    if (inv.hypotheses.length > 0)
      completenessRatios.push(inv.evidence.length / inv.hypotheses.length);
  }

  const evidenceCompleteness
    = completenessRatios.length > 0
      ? completenessRatios.reduce((s, r) => s + r, 0) / completenessRatios.length
      : 0;

  // -- daily trend
  const dailyMap = new Map<string, { count: number; totalDuration: number }>();
  for (const inv of investigations) {
    const date = toYMD(inv.createdAt);
    const entry = dailyMap.get(date) ?? { count: 0, totalDuration: 0 };
    entry.count++;
    if (inv.status === 'completed') {
      entry.totalDuration
        += new Date(inv.updatedAt).getTime() - new Date(inv.createdAt).getTime();
    }
    dailyMap.set(date, entry);
  }

  const dailyTrend: DailyTrend[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { count, totalDuration }]) => ({
      date,
      investigations: count,
      avgDurationMs: count > 0 ? Math.round(totalDuration / count) : 0,
    }));

  // -- weekly trend
  const weeklyMap = new Map<string, { count: number; totalDuration: number }>();
  for (const d of dailyTrend) {
    const weekStart = toWeekStart(d.date);
    const entry = weeklyMap.get(weekStart) ?? { count: 0, totalDuration: 0 };
    entry.count += d.investigations;
    entry.totalDuration += d.avgDurationMs * d.investigations;
    weeklyMap.set(weekStart, entry);
  }

  const weeklyTrend: WeeklyTrend[] = [...weeklyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, { count, totalDuration }]) => ({
      weekStart,
      investigations: count,
      avgDurationMs: count > 0 ? Math.round(totalDuration / count) : 0,
    }));

  return {
    totalInvestigations,
    adoptionRate,
    proactiveHitRate,
    avgInvestigationDurationMs,
    avgTokensPerInvestigation,
    avgQueriesPerInvestigation,
    evidenceCompleteness,
    dailyTrend,
    weeklyTrend,
    computedAt: new Date().toISOString(),
  };
}

export interface MetaRouterDeps {
  investigationStore: IGatewayInvestigationStore;
  feedStore: IGatewayFeedStore;
  /**
   * RBAC surface. The quality meta-dashboard reads investigation aggregates,
   * so we gate on `investigations:read` — anyone who can see investigations
   * can see their roll-up. The holder forwards to the real service once the
   * auth subsystem finishes wiring.
   */
  ac: AccessControlSurface;
}

export function createMetaRouter(deps: MetaRouterDeps): Router {
  const invStore = deps.investigationStore;
  const feed = deps.feedStore;
  const requirePermission = createRequirePermission(deps.ac);

  const router = Router();
  router.use(authMiddleware);
  router.use(requirePermission(() => ac.eval(ACTIONS.InvestigationsRead, 'investigations:*')));

  router.get('/quality', asyncHandler(async (req, res) => {
    const orgId = (req as AuthenticatedRequest).auth!.orgId;
    const metrics = await computeQualityMetrics(invStore, feed, orgId);
    res.json(metrics);
  }));

  return router;
}
