/**
 * Rule: `query-uses-known-labels`
 *
 * For each `{label="value"}` filter in panel queries, verify that the label
 * exists on the metric and (for closed-enum-sized label sets, ≤50 values)
 * the value is one of the known values. Skips regex matchers — those imply
 * the user knows the value space and may legitimately match unknown values.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';
import { extractMetricSelectors } from '../promql-extract.js';

const CLOSED_ENUM_THRESHOLD = 50;

export const queryUsesKnownLabels: LintRule = {
  name: 'query-uses-known-labels',
  description: 'Label selectors must reference real labels (and known values for small enums).',
  defaultSeverity: 'error',
  async check(spec: DashboardSpec, ctx: LintContext): Promise<LintIssue[]> {
    if (!ctx.metricsLabels || !ctx.metricsLabelValues) {
      return [{
        severity: 'info',
        ruleName: 'query-uses-known-labels',
        message: 'rule skipped: metricsLabels/metricsLabelValues tools not available',
      }];
    }
    const issues: LintIssue[] = [];
    // Cache per-metric label sets so we don't refetch within a single run.
    const labelCache = new Map<string, string[]>();
    const valuesCache = new Map<string, string[]>();

    for (const panel of spec.panels) {
      for (const expr of panelQueryExprs(panel)) {
        const selectors = extractMetricSelectors(expr);
        for (const sel of selectors) {
          if (!sel.name || sel.selectors.length === 0) continue;
          let knownLabels = labelCache.get(sel.name);
          if (!knownLabels) {
            knownLabels = (await ctx.metricsLabels(sel.name)).labels;
            labelCache.set(sel.name, knownLabels);
          }
          for (const filter of sel.selectors) {
            if (!knownLabels.includes(filter.label)) {
              issues.push({
                severity: 'error',
                ruleName: 'query-uses-known-labels',
                panelId: panel.id,
                message: `Panel "${panel.title}" uses unknown label "${filter.label}" on metric ${sel.name}.`,
                fixHint: `Known labels: ${knownLabels.slice(0, 10).join(', ')}${knownLabels.length > 10 ? ', ...' : ''}`,
              });
              continue;
            }
            // Regex / negation matchers are intentionally not validated.
            if (filter.op !== '=') continue;
            const cacheKey = `${sel.name}::${filter.label}`;
            let values = valuesCache.get(cacheKey);
            if (!values) {
              values = (await ctx.metricsLabelValues(sel.name, filter.label)).values;
              valuesCache.set(cacheKey, values);
            }
            if (values.length > CLOSED_ENUM_THRESHOLD) continue;
            if (!values.includes(filter.value)) {
              issues.push({
                severity: 'error',
                ruleName: 'query-uses-known-labels',
                panelId: panel.id,
                message: `Panel "${panel.title}" filter ${filter.label}="${filter.value}" not in known values for ${sel.name}.`,
                fixHint: `Known values: ${values.slice(0, 10).join(', ')}`,
              });
            }
          }
        }
      }
    }
    return issues;
  },
};
