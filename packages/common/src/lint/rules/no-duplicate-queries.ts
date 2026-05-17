/**
 * Rule: `no-duplicate-queries`
 *
 * Two panels with identical (whitespace-normalized) queries usually means
 * one was copy-pasted and forgotten. Warn so the agent removes or
 * differentiates them.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';
import { normalizeQuery } from '../promql-extract.js';

export const noDuplicateQueries: LintRule = {
  name: 'no-duplicate-queries',
  description: 'Multiple panels with the same query suggest accidental duplication.',
  defaultSeverity: 'warn',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const groups = new Map<string, Array<{ panelId: string; title: string }>>();
    for (const panel of spec.panels) {
      for (const expr of panelQueryExprs(panel)) {
        const key = normalizeQuery(expr);
        const arr = groups.get(key) ?? [];
        arr.push({ panelId: panel.id, title: panel.title });
        groups.set(key, arr);
      }
    }
    const issues: LintIssue[] = [];
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      for (const m of members) {
        const others = members.filter((x) => x.panelId !== m.panelId).map((x) => `"${x.title}"`).join(', ');
        issues.push({
          severity: 'warn',
          ruleName: 'no-duplicate-queries',
          panelId: m.panelId,
          message: `Panel "${m.title}" shares an identical query with: ${others}.`,
          fixHint: `Query: ${key.slice(0, 120)}`,
        });
      }
    }
    return issues;
  },
};
