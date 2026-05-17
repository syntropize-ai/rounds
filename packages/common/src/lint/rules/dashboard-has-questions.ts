/**
 * Rule: `dashboard-has-questions`
 *
 * Each panel description should be framed as a question the panel answers
 * ("Q: are we within latency SLO?"). Per-panel: missing/non-question
 * description → error. Dashboard-level: if NOT a single panel has a
 * question, emit one extra error so a "pure-stat-wall" dashboard fails
 * cleanly even if individual panels were skipped.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';

const QUESTION_PREFIX = /^\s*(Q:|Question:)\s+/i;

export const dashboardHasQuestions: LintRule = {
  name: 'dashboard-has-questions',
  description: 'Each panel description should start with "Q: ..." stating the question it answers.',
  defaultSeverity: 'error',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    let anyHasQuestion = false;
    for (const panel of spec.panels) {
      const desc = (panel.description ?? '').trim();
      if (desc !== '' && QUESTION_PREFIX.test(desc)) {
        anyHasQuestion = true;
        continue;
      }
      issues.push({
        severity: 'error',
        ruleName: 'dashboard-has-questions',
        panelId: panel.id,
        message: desc === ''
          ? `Panel "${panel.title}" has no description.`
          : `Panel "${panel.title}" description should start with "Q: " or "Question: ".`,
        fixHint: 'Frame the description as the question the panel answers, e.g. "Q: are p99 latencies within SLO?".',
      });
    }
    if (!anyHasQuestion && spec.panels.length > 0) {
      issues.push({
        severity: 'error',
        ruleName: 'dashboard-has-questions',
        message: 'Dashboard has no panels framed as questions — at least one panel must lead with "Q: ...".',
      });
    }
    return issues;
  },
};
