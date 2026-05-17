/**
 * Rule: `high-cardinality-grouping`
 *
 * `by (X)` / `without (X)` on a high-cardinality metric explodes the
 * legend and crushes the renderer. We can't perfectly predict the
 * post-group cardinality, but the upper bound is the underlying series
 * count — if that exceeds 100, warn.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';
import { extractAggregationClauses, extractMetricSelectors } from '../promql-extract.js';

const SERIES_WARN_THRESHOLD = 100;

export const highCardinalityGrouping: LintRule = {
  name: 'high-cardinality-grouping',
  description: 'Grouping a high-cardinality metric produces too many series for one panel.',
  defaultSeverity: 'warn',
  async check(spec: DashboardSpec, ctx: LintContext): Promise<LintIssue[]> {
    if (!ctx.metricsCardinality) {
      return [{
        severity: 'info',
        ruleName: 'high-cardinality-grouping',
        message: 'rule skipped: metricsCardinality tool not available',
      }];
    }
    const issues: LintIssue[] = [];
    const cache = new Map<string, number>();
    for (const panel of spec.panels) {
      for (const expr of panelQueryExprs(panel)) {
        const groups = extractAggregationClauses(expr);
        if (groups.length === 0) continue;
        const selectors = extractMetricSelectors(expr);
        if (selectors.length === 0) continue;
        // Use the first non-empty metric name as the cardinality probe target.
        const target = selectors.find((s) => s.name)?.name;
        if (!target) continue;
        let seriesCount = cache.get(target);
        if (seriesCount === undefined) {
          seriesCount = (await ctx.metricsCardinality(target)).seriesCount;
          cache.set(target, seriesCount);
        }
        if (seriesCount > SERIES_WARN_THRESHOLD) {
          const groupLabel = groups.map((g) => `${g.kind} (${g.labels.join(', ')})`).join(' ');
          issues.push({
            severity: 'warn',
            ruleName: 'high-cardinality-grouping',
            panelId: panel.id,
            message: `Panel "${panel.title}" groups ${target} (${seriesCount} series) with ${groupLabel} — likely to render too many lines.`,
            fixHint: 'Add label filters to narrow the series set or use topk() to cap the displayed lines.',
          });
        }
      }
    }
    return issues;
  },
};
