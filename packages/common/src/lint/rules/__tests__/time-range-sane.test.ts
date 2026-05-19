import { describe, it, expect } from 'vitest';
import { timeRangeSane } from '../time-range-sane.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('time-range-sane', () => {
  it('flags a 10-minute refresh on a 5m-window query', async () => {
    const spec = mkDashboard([
      mkPanel({
        id: 'p1',
        query: 'sum(rate(http_requests_total[5m]))',
        refreshIntervalSec: 600,
      }),
    ]);
    const issues = await timeRangeSane.check(spec, {});
    expect(issues.some((i) => i.panelId === 'p1')).toBe(true);
  });

  it('passes when refresh and window are aligned', async () => {
    const spec = mkDashboard([
      mkPanel({
        id: 'p1',
        query: 'sum(rate(http_requests_total[5m]))',
        refreshIntervalSec: 60,
      }),
    ]);
    const issues = await timeRangeSane.check(spec, {});
    expect(issues).toEqual([]);
  });

  it('flags dashboard-level refresh > 30 days', async () => {
    const spec = mkDashboard(
      [mkPanel({ id: 'p1', query: 'up' })],
      { refreshIntervalSec: 40 * 86400 },
    );
    const issues = await timeRangeSane.check(spec, {});
    expect(issues.some((i) => i.message.includes('30 days'))).toBe(true);
  });
});
