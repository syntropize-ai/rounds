/**
 * Rule: `panel-returns-data`
 *
 * For each panel, execute its query through `metricsQuery`. If the result is
 * empty, emit a WARNING — empty results are a legitimate pre-deployment state
 * (authoring a MongoDB dashboard before MongoDB is scraped, etc.). The
 * warning still lets the agent relay "this panel will be blank until <X> is
 * deployed" to the user; the verify-gate treats warnings as non-blocking.
 * Requires `ctx.metricsQuery`; skips with a single info issue when unavailable.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';

export const panelReturnsData: LintRule = {
  name: 'panel-returns-data',
  description: 'Each panel query should return at least one series (warning only — pre-deploy is legitimate).',
  defaultSeverity: 'warn',
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
            severity: 'warn',
            ruleName: 'panel-returns-data',
            panelId: panel.id,
            message: `Panel "${panel.title}" query returned no data: ${expr.slice(0, 120)}`,
            fixHint: 'If this is pre-deployment, expected. Otherwise verify the metric exists, fix label selectors, or widen the time range.',
          });
        }
      }
    }
    return issues;
  },
};
