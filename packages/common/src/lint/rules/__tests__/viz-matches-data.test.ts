import { describe, it, expect } from 'vitest';
import { vizMatchesData } from '../viz-matches-data.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('viz-matches-data', () => {
  it('flags rate() over counter rendered as a stat tile', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', visualization: 'stat', query: 'sum(rate(http_requests_total[5m]))' }),
    ]);
    const issues = await vizMatchesData.check(spec, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
  });

  it('passes for the same query as a time_series', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', visualization: 'time_series', query: 'sum(rate(http_requests_total[5m]))' }),
    ]);
    const issues = await vizMatchesData.check(spec, {});
    expect(issues).toEqual([]);
  });

  it('passes for a gauge stat (non-rate query)', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', visualization: 'stat', query: 'up' }),
    ]);
    const issues = await vizMatchesData.check(spec, {});
    expect(issues).toEqual([]);
  });
});
