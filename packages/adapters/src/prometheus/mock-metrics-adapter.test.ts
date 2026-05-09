// Contract tests for MockMetricsAdapter — confirm the demo fixture
// satisfies the IMetricsAdapter interface that PrometheusMetricsAdapter
// implements. If these break, the demo CLI cannot wire to the metrics
// surface the agent / alert evaluator expects.

import { describe, it, expect } from 'vitest';
import { MockMetricsAdapter } from './mock-metrics-adapter.js';
import type { IMetricsAdapter } from '../interfaces.js';

describe('MockMetricsAdapter', () => {
  const adapter: IMetricsAdapter = new MockMetricsAdapter();

  it('reports healthy', async () => {
    expect(await adapter.isHealthy()).toBe(true);
  });

  it('lists 5 metric names', async () => {
    const names = await adapter.listMetricNames();
    expect(names).toHaveLength(5);
    expect(names).toContain('cpu_usage_percent');
    expect(names).toContain('api_request_latency_seconds');
  });

  it('instantQuery returns samples for matching metric', async () => {
    const samples = await adapter.instantQuery('cpu_usage_percent');
    expect(samples).toHaveLength(3);
    expect(samples.every((s) => s.labels['__name__'] === 'cpu_usage_percent')).toBe(true);
  });

  it('CPU fixture has a series above the 80 percent demo alert threshold', async () => {
    const samples = await adapter.instantQuery('cpu_usage_percent > 80');
    const hot = samples.find((s) => s.value > 80);
    expect(hot).toBeDefined();
    expect(hot!.labels['pod']).toBe('api-server-0');
  });

  it('rangeQuery yields evenly spaced samples per series', async () => {
    const start = new Date(0);
    const end = new Date(60_000); // 60s window
    const result = await adapter.rangeQuery('cpu_usage_percent', start, end, '15s');
    expect(result.length).toBe(3);
    // 0, 15, 30, 45, 60 → 5 points
    expect(result[0]!.values.length).toBe(5);
  });

  it('testQuery distinguishes known/unknown metrics', async () => {
    expect((await adapter.testQuery('cpu_usage_percent')).ok).toBe(true);
    expect((await adapter.testQuery('definitely_not_a_metric')).ok).toBe(false);
  });

  it('fetchMetadata returns help/unit for known metrics', async () => {
    const meta = await adapter.fetchMetadata(['cpu_usage_percent']);
    expect(meta['cpu_usage_percent']?.unit).toBe('percent');
  });
});
