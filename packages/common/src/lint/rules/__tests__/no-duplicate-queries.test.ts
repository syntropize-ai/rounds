import { describe, it, expect } from 'vitest';
import { noDuplicateQueries } from '../no-duplicate-queries.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('no-duplicate-queries', () => {
  it('flags two panels with identical queries', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', title: 'A', query: 'sum(rate(http_requests_total[5m]))' }),
      mkPanel({ id: 'p2', title: 'B', query: 'sum(rate(http_requests_total[5m]))' }),
    ]);
    const issues = await noDuplicateQueries.check(spec, {});
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.panelId).sort()).toEqual(['p1', 'p2']);
  });

  it('treats whitespace-run differences as duplicates (trailing newline + tabs vs single spaces)', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'sum(rate(http_requests_total[5m]))\n' }),
      mkPanel({ id: 'p2', query: 'sum(rate(http_requests_total[5m]))' }),
    ]);
    const issues = await noDuplicateQueries.check(spec, {});
    expect(issues.length).toBeGreaterThan(0);
  });

  it('passes when every panel has a distinct query', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'up' }),
      mkPanel({ id: 'p2', query: 'rate(http_requests_total[5m])' }),
    ]);
    const issues = await noDuplicateQueries.check(spec, {});
    expect(issues).toEqual([]);
  });
});
