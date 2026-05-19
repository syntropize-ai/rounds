import { describe, it, expect } from 'vitest';
import { highCardinalityGrouping } from '../high-cardinality-grouping.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('high-cardinality-grouping', () => {
  it('warns when grouping a >100-series metric', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'sum(rate(http_requests_total[5m])) by (pod)' }),
    ]);
    const issues = await highCardinalityGrouping.check(spec, {
      metricsCardinality: async () => ({ seriesCount: 5000 }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warn');
  });

  it('passes when cardinality is small', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'sum(rate(http_requests_total[5m])) by (status)' }),
    ]);
    const issues = await highCardinalityGrouping.check(spec, {
      metricsCardinality: async () => ({ seriesCount: 5 }),
    });
    expect(issues).toEqual([]);
  });

  it('passes when there is no aggregation clause to group on', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'rate(http_requests_total[5m])' }),
    ]);
    const issues = await highCardinalityGrouping.check(spec, {
      metricsCardinality: async () => ({ seriesCount: 99999 }),
    });
    expect(issues).toEqual([]);
  });
});
