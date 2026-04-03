// Quality meta-dashboard - GET /api/meta/quality
// Aggregates platform quality metrics: adoption rate, investigation cost,
// evidence completeness, and daily trend data.
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { defaultInvestigationStore } from './investigation/store.js';
import { feedStore } from './feed-store.js';
export const metaRouter = Router();
// All meta routes require authentication and meta:read permission
metaRouter.use(authMiddleware);
metaRouter.use(requirePermission('meta:read'));
// -- Helpers
function toYMD(iso) {
    return iso.slice(0, 10); // "YYYY-MM-DD"
}
/** Return the ISO date of the Monday of the week containing `date`. */
function toWeekStart(isoDate) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    const day = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // days to subtract to reach Monday
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
}
// -- Computation
export function computeQualityMetrics() {
    const investigations = defaultInvestigationStore.findAll();
    const total_investigations = investigations.length;
    // -- adoption rate
    const feedStats = feedStore.getStats();
    const positive = (feedStats.byVerdict['useful'] ?? 0)
        + (feedStats.byVerdict['root_cause_correct'] ?? 0);
    const adoption_rate = feedStats.withFeedback > 0 ? positive / feedStats.withFeedback : 0;
    // -- Investigation duration
    const completed = investigations.filter((i) => i.status === 'completed');
    const durations = completed.map((i) => new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime());
    const avg_investigation_duration_ms = durations.length > 0
        ? durations.reduce((s, d) => s + d, 0) / durations.length
        : 0;
    // -- token / query cost
    let totalTokens = 0;
    let totalQueries = 0;
    let invWithCost = 0;
    for (const inv of investigations) {
        const stepTokens = inv.plan.steps.reduce((s, step) => s + (step.cost?.tokens ?? 0), 0);
        const stepQueries = inv.plan.steps.reduce((s, step) => s + (step.cost?.queries ?? 0), 0);
        if (stepTokens > 0 || stepQueries > 0) {
            totalTokens += stepTokens;
            totalQueries += stepQueries;
            invWithCost++;
        }
    }
    const avg_tokens_per_investigation = invWithCost > 0 ? totalTokens / invWithCost : 0;
    const avg_queries_per_investigation = invWithCost > 0 ? totalQueries / invWithCost : 0;
    // -- proactive hit rate
    const proactive_hit_rate = feedStats.proactiveHitRate;
    // -- evidence completeness
    const completenessRatios = [];
    for (const inv of investigations) {
        if (inv.hypotheses.length > 0)
            completenessRatios.push(inv.evidence.length / inv.hypotheses.length);
    }
    const evidence_completeness = completenessRatios.length > 0
        ? completenessRatios.reduce((s, r) => s + r, 0) / completenessRatios.length
        : 0;
    // -- daily trend
    const dailyMap = new Map();
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
    const daily_trend = [...dailyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { count, totalDuration }]) => ({
        date,
        investigations: count,
        avg_duration_ms: count > 0 ? Math.round(totalDuration / count) : 0,
    }));
    // -- weekly trend
    const weeklyMap = new Map();
    for (const d of daily_trend) {
        const weekStart = toWeekStart(d.date);
        const entry = weeklyMap.get(weekStart) ?? { count: 0, totalDuration: 0 };
        entry.count += d.investigations;
        entry.totalDuration += d.avg_duration_ms * d.investigations;
        weeklyMap.set(weekStart, entry);
    }
    const weekly_trend = [...weeklyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week_start, { count, totalDuration }]) => ({
        week_start,
        investigations: count,
        avg_duration_ms: count > 0 ? Math.round(totalDuration / count) : 0,
    }));
    return {
        total_investigations,
        adoption_rate,
        proactive_hit_rate,
        avg_investigation_duration_ms,
        avg_tokens_per_investigation,
        avg_queries_per_investigation,
        evidence_completeness,
        daily_trend,
        weekly_trend,
        computed_at: new Date().toISOString(),
    };
}
// -- Route
metaRouter.get('/quality', (_req, res) => {
    const metrics = computeQualityMetrics();
    res.json(metrics);
});
//# sourceMappingURL=meta.js.map