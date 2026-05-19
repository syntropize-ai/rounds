import { describe, it, expect } from 'vitest';
import { histogramQuantileForm } from '../histogram-quantile-form.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('histogram-quantile-form', () => {
  it('rejects histogram_quantile over a raw _bucket (no rate)', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'histogram_quantile(0.95, http_request_duration_seconds_bucket)' }),
    ]);
    const issues = await histogramQuantileForm.check(spec, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
  });

  it('rejects sum_over_time instead of rate', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'histogram_quantile(0.95, sum(sum_over_time(http_request_duration_seconds_bucket[5m])) by (le))' }),
    ]);
    const issues = await histogramQuantileForm.check(spec, {});
    expect(issues).toHaveLength(1);
  });

  it('accepts the canonical shape', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))' }),
      mkPanel({ id: 'p2', query: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="api"}[5m])) by (le, handler))' }),
    ]);
    const issues = await histogramQuantileForm.check(spec, {});
    expect(issues).toEqual([]);
  });

  it('ignores panels that do not call histogram_quantile', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'rate(http_requests_total[5m])' }),
    ]);
    const issues = await histogramQuantileForm.check(spec, {});
    expect(issues).toEqual([]);
  });
});
