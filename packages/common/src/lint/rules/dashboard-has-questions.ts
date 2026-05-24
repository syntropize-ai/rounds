/**
 * Rule: `dashboard-has-questions`
 *
 * Each panel description should be framed as a question the panel answers
 * ("Q: are we within latency SLO?"). This is a STYLE guideline — it surfaces
 * as a warning so the agent (or human) gets the nudge but the dashboard
 * still saves. Blocking on it created painful UX where the verify-gate
 * rejected on a missing prefix and the agent misdiagnosed the failure as
 * a data problem.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';

const QUESTION_PREFIX = /^\s*(Q:|Question:)\s+/i;

export const dashboardHasQuestions: LintRule = {
  name: 'dashboard-has-questions',
  description: 'Each panel description should start with "Q: ..." stating the question it answers (style hint, non-blocking).',
  defaultSeverity: 'warn',
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
        severity: 'warn',
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
        severity: 'warn',
        ruleName: 'dashboard-has-questions',
        message: 'No panel description is framed as a question. Consider leading at least one with "Q: ..." for clarity.',
      });
    }
    return issues;
  },
};
