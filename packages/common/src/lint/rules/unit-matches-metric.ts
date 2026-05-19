/**
 * Rule: `unit-matches-metric`
 *
 * Heuristically infer the expected unit from the metric name suffix and
 * warn when the panel's declared `unit` disagrees. Pure rule — no backend
 * calls needed.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';
import { extractMetricSelectors } from '../promql-extract.js';
import { resolvePanelUnit } from '../../utils/panel-units.js';

interface UnitExpectation {
  /** Accepted unit strings for the panel.unit field. */
  expected: string[];
  /** Friendly description for the issue message. */
  label: string;
}

/**
 * Suffix → expected unit. Order matters: longer suffixes first so
 * `_seconds_total` wins over `_total`.
 */
const SUFFIX_RULES: Array<{ suffix: string; rule: UnitExpectation }> = [
  { suffix: '_seconds_total', rule: { expected: ['s', 'seconds', 'ms', 'short'], label: 'time (seconds)' } },
  { suffix: '_bytes_total',   rule: { expected: ['bytes', 'decbytes', 'binBps', 'Bps'], label: 'bytes' } },
  { suffix: '_seconds',       rule: { expected: ['s', 'seconds', 'ms'], label: 'time (seconds)' } },
  { suffix: '_bytes',         rule: { expected: ['bytes', 'decbytes'], label: 'bytes' } },
  { suffix: '_milliseconds',  rule: { expected: ['ms', 'milliseconds'], label: 'time (ms)' } },
  { suffix: '_ratio',         rule: { expected: ['percentunit', 'percent'], label: 'ratio (0–1)' } },
  { suffix: '_percent',       rule: { expected: ['percent', 'percentunit'], label: 'percentage' } },
  { suffix: '_celsius',       rule: { expected: ['celsius'], label: 'temperature (°C)' } },
];

export const unitMatchesMetric: LintRule = {
  name: 'unit-matches-metric',
  description: 'Panel unit should match the metric name suffix (e.g. _bytes → bytes).',
  defaultSeverity: 'warn',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    for (const panel of spec.panels) {
      const unit = resolvePanelUnit(panel);
      if (!unit) continue;
      const exprs = panelQueryExprs(panel);
      for (const expr of exprs) {
        const selectors = extractMetricSelectors(expr);
        for (const sel of selectors) {
          if (!sel.name) continue;
          const match = SUFFIX_RULES.find((r) => sel.name.endsWith(r.suffix));
          if (!match) continue;
          if (!match.rule.expected.includes(unit)) {
            issues.push({
              severity: 'warn',
              ruleName: 'unit-matches-metric',
              panelId: panel.id,
              message: `Panel "${panel.title}" unit "${unit}" doesn't match ${sel.name} (expected ${match.rule.label}: ${match.rule.expected.join(' | ')}).`,
            });
            break;
          }
        }
      }
    }
    return issues;
  },
};
