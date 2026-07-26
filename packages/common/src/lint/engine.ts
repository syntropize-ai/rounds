/**
 * LintEngine — pluggable rule registry + runner.
 *
 * Register rules, then call `run(spec, ctx, opts?)` to get an aggregated
 * issue list. The engine never throws on a rule failure: it catches the
 * error and produces an `info`-severity issue so one bad rule does not
 * poison the rest of the run.
 */

import type {
  DashboardSpec,
  LintContext,
  LintIssue,
  LintRule,
  LintRunOptions,
} from './types.js';

export class LintEngine {
  private readonly rules = new Map<string, LintRule>();

  register(rule: LintRule): void {
    this.rules.set(rule.name, rule);
  }

  /** Return the registered rule list in insertion order. Test helper. */
  registered(): LintRule[] {
    return Array.from(this.rules.values());
  }

  async run(
    spec: DashboardSpec,
    ctx: LintContext,
    opts?: LintRunOptions,
  ): Promise<LintIssue[]> {
    const only = opts?.only ? new Set(opts.only) : null;
    const skip = opts?.skip ? new Set(opts.skip) : null;
    const issues: LintIssue[] = [];
    for (const rule of this.rules.values()) {
      if (only && !only.has(rule.name)) continue;
      if (skip && skip.has(rule.name)) continue;
      try {
        const out = await rule.check(spec, ctx);
        for (const issue of out) issues.push(issue);
      } catch (err) {
        // `warn`, not `info`. Callers decide pass/fail with
        // `every(i => i.severity !== 'error')`, so an `info` made a rule that
        // crashed indistinguishable from a rule that ran and approved — the
        // check silently stopped existing while the dashboard still reported
        // as linted. `warn` is visible without failing the save, which is the
        // honest position: we do not know whether this rule would have passed.
        issues.push({
          severity: 'warn',
          ruleName: rule.name,
          message: `rule did not run: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return issues;
  }
}
