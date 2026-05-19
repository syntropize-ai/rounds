import { describe, it, expect } from 'vitest';
import { dashboardHasQuestions } from '../dashboard-has-questions.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('dashboard-has-questions', () => {
  it('flags panels missing a Q: prefix', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', description: 'Just some text' }),
    ]);
    const issues = await dashboardHasQuestions.check(spec, {});
    // One per-panel error + one dashboard-level error.
    expect(issues.filter((i) => i.panelId === 'p1')).toHaveLength(1);
    expect(issues.some((i) => i.panelId === undefined)).toBe(true);
  });

  it('passes when every panel uses Q: ', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', description: 'Q: are we within SLO?' }),
      mkPanel({ id: 'p2', description: 'Question: how busy is the cluster?' }),
    ]);
    const issues = await dashboardHasQuestions.check(spec, {});
    expect(issues).toEqual([]);
  });

  it('flags empty descriptions distinctly', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', description: '' }),
    ]);
    const issues = await dashboardHasQuestions.check(spec, {});
    const panelIssue = issues.find((i) => i.panelId === 'p1')!;
    expect(panelIssue.message).toMatch(/no description/);
  });
});
