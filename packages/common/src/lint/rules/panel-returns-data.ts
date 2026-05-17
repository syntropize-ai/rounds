/**
 * Rule: `panel-returns-data`
 *
 * For each panel, execute its query through `metricsQuery`. If the result is
 * empty, emit an error — the panel would render blank for the user. Requires
 * `ctx.metricsQuery`; skips with a single info issue when unavailable.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';

export const panelReturnsData: LintRule = {
  name: 'panel-returns-data',
  description: 'Each panel query must return at least one series.',
  defaultSeverity: 'error',
  async check(spec: DashboardSpec, ctx: LintContext): Promise<LintIssue[]> {
    if (!ctx.metricsQuery) {
      return [{
        severity: 'info',
        ruleName: 'panel-returns-data',
        message: 'rule skipped: metricsQuery tool not available in this context',
      }];
    }
    const issues: LintIssue[] = [];
    for (const panel of spec.panels) {
      for (const expr of panelQueryExprs(panel)) {
        const res = await ctx.metricsQuery(expr);
        if (res.resultLen === 0) {
          issues.push({
            severity: 'error',
            ruleName: 'panel-returns-data',
            panelId: panel.id,
            message: `Panel "${panel.title}" query returned no data: ${expr.slice(0, 120)}`,
            fixHint: 'Verify the metric exists, fix label selectors, or widen the time range.',
          });
        }
      }
    }
    return issues;
  },
};
