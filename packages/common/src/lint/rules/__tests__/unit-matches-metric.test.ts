import { describe, it, expect } from 'vitest';
import { unitMatchesMetric } from '../unit-matches-metric.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('unit-matches-metric', () => {
  it('warns when _bytes metric has a non-bytes unit', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'node_memory_used_bytes', unit: 'percent' }),
    ]);
    const issues = await unitMatchesMetric.check(spec, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warn');
  });

  it('passes when _seconds metric uses s/ms unit', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'http_request_duration_seconds', unit: 's' }),
      mkPanel({ id: 'p2', query: 'http_request_duration_seconds', unit: 'ms' }),
    ]);
    const issues = await unitMatchesMetric.check(spec, {});
    expect(issues).toEqual([]);
  });

  it('ignores panels with no declared unit', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'node_memory_used_bytes' }),
    ]);
    const issues = await unitMatchesMetric.check(spec, {});
    expect(issues).toEqual([]);
  });
});
