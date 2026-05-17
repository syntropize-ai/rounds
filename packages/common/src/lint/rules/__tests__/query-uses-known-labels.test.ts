import { describe, it, expect } from 'vitest';
import { queryUsesKnownLabels } from '../query-uses-known-labels.js';
import { mkDashboard, mkPanel } from './_fixtures.js';

describe('query-uses-known-labels', () => {
  it('flags an unknown label name', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'http_requests_total{nope="x"}' }),
    ]);
    const issues = await queryUsesKnownLabels.check(spec, {
      metricsLabels: async () => ({ labels: ['method', 'status', 'handler'] }),
      metricsLabelValues: async () => ({ values: [] }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/unknown label "nope"/);
  });

  it('flags a value outside a small closed enum', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'http_requests_total{method="TELEPORT"}' }),
    ]);
    const issues = await queryUsesKnownLabels.check(spec, {
      metricsLabels: async () => ({ labels: ['method'] }),
      metricsLabelValues: async () => ({ values: ['GET', 'POST', 'PUT', 'DELETE'] }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/TELEPORT/);
  });

  it('passes when label + value are both known', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'http_requests_total{method="GET"}' }),
    ]);
    const issues = await queryUsesKnownLabels.check(spec, {
      metricsLabels: async () => ({ labels: ['method'] }),
      metricsLabelValues: async () => ({ values: ['GET', 'POST'] }),
    });
    expect(issues).toEqual([]);
  });

  it('skips value-check for large (non-enum) label value sets', async () => {
    const spec = mkDashboard([
      mkPanel({ id: 'p1', query: 'http_requests_total{pod="any-value"}' }),
    ]);
    const big = Array.from({ length: 200 }, (_, i) => `pod-${i}`);
    const issues = await queryUsesKnownLabels.check(spec, {
      metricsLabels: async () => ({ labels: ['pod'] }),
      metricsLabelValues: async () => ({ values: big }),
    });
    expect(issues).toEqual([]);
  });

  it('skips with info when discovery tools are not available', async () => {
    const spec = mkDashboard([mkPanel({ id: 'p1', query: 'up{job="foo"}' })]);
    const issues = await queryUsesKnownLabels.check(spec, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
  });
});
