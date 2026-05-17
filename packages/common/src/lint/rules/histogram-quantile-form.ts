/**
 * Rule: `histogram-quantile-form`
 *
 * `histogram_quantile` is misused often enough that we ban every shape
 * except the canonical one:
 *   histogram_quantile(<float>, sum(rate(<metric>_bucket[<range>])) by (le, ...))
 *
 * Common bugs caught:
 *   - histogram_quantile over a raw _bucket without rate()  (almost always wrong)
 *   - missing `by (le, ...)` clause on the aggregation
 *   - using sum_over_time / increase instead of rate
 *
 * Pure rule.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';

const CANONICAL = /histogram_quantile\s*\(\s*[0-9.]+\s*,\s*sum\s*\(\s*rate\s*\(\s*[a-zA-Z_:][a-zA-Z_0-9:]*_bucket\s*\{[^}]*\}\s*\[[^\]]+\]\s*\)\s*\)\s*by\s*\(\s*le\b[^)]*\)\s*\)/;
const CANONICAL_NO_SELECTORS = /histogram_quantile\s*\(\s*[0-9.]+\s*,\s*sum\s*\(\s*rate\s*\(\s*[a-zA-Z_:][a-zA-Z_0-9:]*_bucket\s*\[[^\]]+\]\s*\)\s*\)\s*by\s*\(\s*le\b[^)]*\)\s*\)/;

export const histogramQuantileForm: LintRule = {
  name: 'histogram-quantile-form',
  description: 'histogram_quantile must wrap sum(rate(..._bucket[range])) by (le).',
  defaultSeverity: 'error',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    for (const panel of spec.panels) {
      for (const expr of panelQueryExprs(panel)) {
        if (!/histogram_quantile\s*\(/.test(expr)) continue;
        if (CANONICAL.test(expr) || CANONICAL_NO_SELECTORS.test(expr)) continue;
        issues.push({
          severity: 'error',
          ruleName: 'histogram-quantile-form',
          panelId: panel.id,
          message: `Panel "${panel.title}" uses non-canonical histogram_quantile shape.`,
          fixHint:
            'Use: histogram_quantile(0.95, sum(rate(metric_bucket[5m])) by (le)). ' +
            'Common mistakes: omitting rate(), omitting by (le), or using increase()/sum_over_time().',
        });
      }
    }
    return issues;
  },
};
