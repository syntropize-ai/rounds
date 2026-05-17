/**
 * Rule: `time-range-sane`
 *
 * Two checks:
 *   1. Panel refresh > 5 minutes while the query uses a `[5m]` window
 *      → mismatch (the data is averaged over 5m but refreshed every 10m+).
 *   2. Dashboard default refresh > 7 days (604800s) → info (likely
 *      too slow); > 30d on initial load is also info-severity.
 *
 * Pure rule. Dashboard-level checks emit panelId-less issues.
 */

import type { DashboardSpec, LintContext, LintIssue, LintRule } from '../types.js';
import { panelQueryExprs } from '../_panel-queries.js';
import { extractRangeVectors, rangeTokenToSeconds } from '../promql-extract.js';

const SEVEN_DAYS_SECONDS = 7 * 86400;
const THIRTY_DAYS_SECONDS = 30 * 86400;

export const timeRangeSane: LintRule = {
  name: 'time-range-sane',
  description: 'Refresh interval and dashboard time window should match the query windows.',
  defaultSeverity: 'info',
  async check(spec: DashboardSpec, _ctx: LintContext): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];

    for (const panel of spec.panels) {
      const refresh = panel.refreshIntervalSec;
      if (typeof refresh !== 'number' || refresh <= 300) continue;
      for (const expr of panelQueryExprs(panel)) {
        const ranges = extractRangeVectors(expr);
        const tightest = ranges
          .map(rangeTokenToSeconds)
          .filter((n) => Number.isFinite(n))
          .reduce((acc, n) => (acc === null || n < acc ? n : acc), null as number | null);
        if (tightest !== null && tightest <= 300 && refresh >= tightest * 2) {
          issues.push({
            severity: 'info',
            ruleName: 'time-range-sane',
            panelId: panel.id,
            message: `Panel "${panel.title}" refreshes every ${refresh}s but queries a ${tightest}s window — data ages between refreshes.`,
            fixHint: `Drop refreshIntervalSec to ≤${tightest}s or widen the range window.`,
          });
          break;
        }
      }
    }

    // Dashboard-level refresh sanity. We only have `refreshIntervalSec` on
    // Dashboard (no explicit "default time range" field), so reuse it as a
    // proxy for the dashboard-level refresh cadence.
    if (typeof spec.refreshIntervalSec === 'number') {
      if (spec.refreshIntervalSec > THIRTY_DAYS_SECONDS) {
        issues.push({
          severity: 'info',
          ruleName: 'time-range-sane',
          message: `Dashboard refresh interval ${spec.refreshIntervalSec}s exceeds 30 days — verify this is intentional.`,
        });
      } else if (spec.refreshIntervalSec > SEVEN_DAYS_SECONDS) {
        issues.push({
          severity: 'info',
          ruleName: 'time-range-sane',
          message: `Dashboard refresh interval ${spec.refreshIntervalSec}s exceeds 7 days — most dashboards refresh more often.`,
        });
      }
    }

    return issues;
  },
};
