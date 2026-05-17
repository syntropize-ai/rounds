/**
 * Rule: `missing-grouping-dim`
 *
 * When a panel title says "per pod" / "by service" but the query has no
 * matching `by (pod)` / `by (service)`, the rendered chart shows one
 * aggregate line — not what the user asked for. Pure rule.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';
import { extractAggregationClauses } from '../promql-extract.js';

/** Title keyword → required label name in the by-clause. */
const KEYWORD_TO_LABEL: Array<{ keyword: RegExp; label: string }> = [
  { keyword: /\bper\s+pod\b|\bby\s+pod\b/i,        label: 'pod' },
  { keyword: /\bper\s+service\b|\bby\s+service\b/i, label: 'service' },
  { keyword: /\bper\s+workload\b|\bby\s+workload\b/i, label: 'workload' },
  { keyword: /\bper\s+namespace\b|\bby\s+namespace\b/i, label: 'namespace' },
  { keyword: /\bper\s+node\b|\bby\s+node\b/i,      label: 'node' },
  { keyword: /\bper\s+instance\b|\bby\s+instance\b/i, label: 'instance' },
  { keyword: /\bper\s+endpoint\b|\bby\s+endpoint\b/i, label: 'endpoint' },
  { keyword: /\bper\s+handler\b|\bby\s+handler\b/i, label: 'handler' },
  { keyword: /\bper\s+status\b|\bby\s+status\b/i,  label: 'status' },
];

export const missingGroupingDim: LintRule = {
  name: 'missing-grouping-dim',
  description: 'A "per X" title should be backed by a `by (X)` aggregation in the query.',
  defaultSeverity: 'warn',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    for (const panel of spec.panels) {
      for (const { keyword, label } of KEYWORD_TO_LABEL) {
        if (!keyword.test(panel.title)) continue;
        // Look at all queries; need at least one `by (...label...)` clause.
        const exprs = panelQueryExprs(panel);
        if (exprs.length === 0) continue;
        const hasByLabel = exprs.some((expr) => {
          const clauses = extractAggregationClauses(expr);
          return clauses.some((c) => c.kind === 'by' && c.labels.includes(label));
        });
        if (!hasByLabel) {
          issues.push({
            severity: 'warn',
            ruleName: 'missing-grouping-dim',
            panelId: panel.id,
            message: `Panel "${panel.title}" implies grouping by ${label} but no \`by (${label})\` clause is present.`,
            fixHint: `Add \`by (${label})\` to the aggregation, or rename the panel.`,
          });
        }
      }
    }
    return issues;
  },
};
