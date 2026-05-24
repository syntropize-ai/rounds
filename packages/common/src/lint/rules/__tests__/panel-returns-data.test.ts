import { describe, it, expect } from 'vitest';
import { panelReturnsData } from '../panel-returns-data.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('panel-returns-data', () => {
  it('warns (does not error) on panels whose query returns no series — pre-deploy is legit', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', title: 'Empty', query: 'up{job="missing"}' }),
    ]);
    const issues = await panelReturnsData.check(spec, {
      metricsQuery: async () => ({ resultLen: 0 }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warn');
    expect(issues[0]!.panelId).toBe('p1');
  });

  it('passes when the query returns data', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'up' }),
    ]);
    const issues = await panelReturnsData.check(spec, {
      metricsQuery: async () => ({ resultLen: 3 }),
    });
    expect(issues).toEqual([]);
  });

  it('skips with info when metricsQuery is not provided', async () => {
    const spec = mkDashboard([mkPanel({ id: 'p1', query: 'up' })]);
    const issues = await panelReturnsData.check(spec, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.message).toMatch(/skipped/);
  });
});
