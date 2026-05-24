import { describe, expect, it } from 'vitest';
import { isCanonicalPanelUnit, resolvePanelDisplayUnit, resolvePanelUnit } from './panel-units.js';

describe('resolvePanelUnit', () => {
  it('normalizes common unit aliases', () => {
    expect(resolvePanelUnit({ unit: 'req/s' })).toBe('reqps');
    expect(resolvePanelUnit({ unit: '%' })).toBe('percent');
    expect(resolvePanelUnit({ unit: 'bytes/s' })).toBe('Bps');
    expect(isCanonicalPanelUnit('qps')).toBe(true);
  });

  it('corrects CPU utilization panels that were mislabeled as request rate', () => {
    expect(resolvePanelUnit({
      title: 'CPU utilization',
      unit: 'reqps',
      queries: [{ expr: 'sum(rate(container_cpu_usage_seconds_total[5m])) * 100' }],
    })).toBe('percent');
  });

  it('infers common units when the panel omits unit', () => {
    expect(resolvePanelUnit({
      title: 'Request rate',
      queries: [{ expr: 'sum(rate(http_requests_total[5m]))' }],
    })).toBe('reqps');
    expect(resolvePanelUnit({
      title: 'Memory used',
      queries: [{ expr: 'container_memory_working_set_bytes' }],
    })).toBe('bytes');
    expect(resolvePanelUnit({
      title: 'p99 latency',
      queries: [{ expr: 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))' }],
    })).toBe('s');
  });

  it('uses metric metadata before title/query heuristics', () => {
    expect(resolvePanelUnit({
      title: 'CPU usage',
      queries: [{ expr: 'cpu_usage_percent' }],
      metadataByMetric: {
        cpu_usage_percent: { type: 'gauge', help: 'CPU usage', unit: 'percent' },
      },
    })).toBe('percent');
    expect(resolvePanelUnit({
      title: 'Network transmit',
      queries: [{ expr: 'sum(rate(container_network_transmit_bytes_total[5m]))' }],
      metadataByMetric: {
        container_network_transmit_bytes_total: { type: 'counter', help: 'TX bytes', unit: 'bytes' },
      },
    })).toBe('Bps');
  });

  it('does not turn CPU seconds counters into percent without percent semantics', () => {
    expect(resolvePanelUnit({
      title: 'CPU cores used',
      queries: [{ expr: 'sum(rate(container_cpu_usage_seconds_total[5m]))' }],
      metadataByMetric: {
        container_cpu_usage_seconds_total: { type: 'counter', help: 'CPU seconds', unit: 'seconds' },
      },
    })).toBe('short');
  });

  it('returns a valueScale for CPU seconds utilization queries', () => {
    expect(resolvePanelDisplayUnit({
      title: 'CPU Usage by Proxy',
      queries: [{ expr: 'sum(rate(process_cpu_seconds_total[5m]))' }],
      metadataByMetric: {
        process_cpu_seconds_total: { type: 'counter', help: 'CPU seconds', unit: 'seconds' },
      },
    })).toEqual({ unit: 'percent', valueScale: 100 });

    expect(resolvePanelDisplayUnit({
      title: 'CPU utilization',
      queries: [{ expr: 'sum(rate(container_cpu_usage_seconds_total[5m])) * 100' }],
    })).toEqual({ unit: 'percent', valueScale: 1 });
  });
});
