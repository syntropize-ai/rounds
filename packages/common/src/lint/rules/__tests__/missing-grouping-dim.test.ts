import { describe, it, expect } from 'vitest';
import { missingGroupingDim } from '../missing-grouping-dim.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('missing-grouping-dim', () => {
  it('warns when "per pod" title lacks by (pod)', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', title: 'CPU per pod', query: 'sum(rate(container_cpu_usage[5m]))' }),
    ]);
    const issues = await missingGroupingDim.check(spec, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/by \(pod\)/);
  });

  it('passes when by (pod) is present', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', title: 'CPU per pod', query: 'sum(rate(container_cpu_usage[5m])) by (pod)' }),
    ]);
    const issues = await missingGroupingDim.check(spec, {});
    expect(issues).toEqual([]);
  });

  it('ignores titles without a per/by keyword', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', title: 'Total request rate', query: 'sum(rate(http_requests_total[5m]))' }),
    ]);
    const issues = await missingGroupingDim.check(spec, {});
    expect(issues).toEqual([]);
  });
});
