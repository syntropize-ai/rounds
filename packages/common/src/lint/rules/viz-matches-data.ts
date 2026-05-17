/**
 * Rule: `viz-matches-data`
 *
 * A `stat` tile collapses a series to a single number — wrong choice for
 * a `rate(...)` over a counter, which is inherently a time series. Suggest
 * `time_series` or `bar` instead. Pure rule.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';

export const vizMatchesData: LintRule = {
  name: 'viz-matches-data',
  description: 'Visualization should fit the query shape (e.g. rate() over a counter is a time series, not a stat).',
  defaultSeverity: 'info',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    for (const panel of spec.panels) {
      if (panel.visualization !== 'stat') continue;
      const exprs = panelQueryExprs(panel);
      for (const expr of exprs) {
        // rate(...) / irate(...) over a counter — almost always a series.
        if (/\b(rate|irate)\s*\(/.test(expr)) {
          issues.push({
            severity: 'info',
            ruleName: 'viz-matches-data',
            panelId: panel.id,
            message: `Panel "${panel.title}" renders a rate() query as a stat tile — the single number will fluctuate.`,
            fixHint: 'Use visualization="time_series" or "bar" so the rate is shown over time.',
          });
          break;
        }
      }
    }
    return issues;
  },
};
