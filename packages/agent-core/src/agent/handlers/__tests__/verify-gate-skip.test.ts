/**
 * The verify gate must not report `ok` for work it did not do.
 *
 * With no metrics connector configured every panel skips preview, so
 * `previewIssues` stays empty and `ok` — computed as "no issue has severity
 * error" — comes back true. Not rejecting the save there is deliberate and
 * documented: it would block offline and pre-deployment authoring. Reporting
 * it as verified is a different claim, and `formatVerifyReport` is only
 * reached on the failing path, so nothing on the passing path ever mentioned
 * that the queries had not run.
 */

import { describe, it, expect } from 'vitest';
import { runDashboardVerifyGate } from '../verify-gate.js';
import { makeFakeActionContext } from '../_test-helpers.js';

const panel = {
  title: 'Error rate',
  visualization: 'timeseries',
  queries: [{ refId: 'A', expr: 'sum(rate(errors[5m]))' }],
};

describe('runDashboardVerifyGate', () => {
  it('counts the panels it could not preview', async () => {
    const ctx = makeFakeActionContext({});
    ctx.allConnectors = [];
    const report = await runDashboardVerifyGate(ctx, { panels: [panel, panel] as never });
    expect(report.previewSkippedPanels).toBe(2);
    // Still ok — the save is allowed. The point is that the caller can now
    // tell the difference between "checked and clean" and "not checked".
    expect(report.ok).toBe(true);
  });

  it('reports nothing skipped once a metrics connector exists', async () => {
    const ctx = makeFakeActionContext({});
    ctx.allConnectors = [{ id: 'p1', type: 'prometheus', name: 'prom' } as never];
    const report = await runDashboardVerifyGate(ctx, { panels: [panel] as never });
    expect(report.previewSkippedPanels).toBe(0);
  });
});

describe('a lint rule that crashed is not a lint rule that passed', () => {
  it('records the failure at warn, so it is visible without blocking', async () => {
    const { LintEngine } = await import('@agentic-obs/common');
    const engine = new LintEngine();
    engine.register({
      name: 'explodes',
      check: async () => { throw new Error('boom'); },
    } as never);
    const issues = await engine.run({ panels: [] } as never, {} as never);
    // `info` passed the `severity !== 'error'` test callers use, so a rule
    // that stopped working looked exactly like one that approved the spec.
    expect(issues[0]?.severity).toBe('warn');
    expect(issues[0]?.message).toContain('did not run');
  });
});
