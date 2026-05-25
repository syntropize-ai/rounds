import { describe, expect, it } from 'vitest';
import { isCanonicalPanelUnit, resolvePanelDisplayUnit, resolvePanelUnit } from './panel-units.js';

describe('resolvePanelUnit', () => {
  it('normalizes common unit aliases', () => {
    expect(resolvePanelUnit({ unit: 'req/s' })).toBe('reqps');
    expect(resolvePanelUnit({ unit: '%' })).toBe('percent');
    expect(resolvePanelUnit({ unit: 'bytes/s' })).toBe('Bps');
    expect(isCanonicalPanelUnit('qps')).toBe(true);
  });

  it('honors the declared unit verbatim', () => {
    expect(resolvePanelUnit({ unit: 'percent' })).toBe('percent');
    expect(resolvePanelUnit({ unit: 's' })).toBe('s');
    expect(resolvePanelUnit({ unit: 'Bps' })).toBe('Bps');
  });

  it('falls back to metadata unit when no unit is declared', () => {
    expect(resolvePanelUnit({
      title: 'CPU usage',
      queries: [{ expr: 'cpu_usage_percent' }],
      metadataByMetric: {
        cpu_usage_percent: { type: 'gauge', help: 'CPU usage', unit: 'percent' },
      },
    })).toBe('percent');
    expect(resolvePanelUnit({
      title: 'Bytes received',
      queries: [{ expr: 'container_network_receive_bytes_total' }],
      metadataByMetric: {
        container_network_receive_bytes_total: { type: 'counter', help: 'RX bytes', unit: 'bytes' },
      },
    })).toBe('bytes');
  });

  it('declared unit wins over metadata unit', () => {
    expect(resolvePanelUnit({
      unit: 'short',
      queries: [{ expr: 'cpu_usage_percent' }],
      metadataByMetric: {
        cpu_usage_percent: { type: 'gauge', help: 'CPU usage', unit: 'percent' },
      },
    })).toBe('short');
  });

  it('returns undefined when neither declared nor metadata unit is set', () => {
    expect(resolvePanelUnit({
      title: 'CPU cores used',
      queries: [{ expr: 'sum(rate(container_cpu_usage_seconds_total[5m]))' }],
    })).toBeUndefined();
  });
});

describe('resolvePanelDisplayUnit', () => {
  it('rewrites percentunit to percent with valueScale=100 (Prometheus definition)', () => {
    expect(resolvePanelDisplayUnit({ unit: 'percentunit' })).toEqual({
      unit: 'percent',
      valueScale: 100,
    });
    expect(resolvePanelDisplayUnit({
      queries: [{ expr: 'whatever' }],
      metadataByMetric: { whatever: { type: 'gauge', unit: 'percentunit' } },
    })).toEqual({ unit: 'percent', valueScale: 100 });
  });

  it('leaves percent (already in 0..100) alone', () => {
    expect(resolvePanelDisplayUnit({ unit: 'percent' })).toEqual({
      unit: 'percent',
      valueScale: 1,
    });
  });

  it('uses valueScale=1 for non-percent units', () => {
    expect(resolvePanelDisplayUnit({ unit: 'bytes' })).toEqual({ unit: 'bytes', valueScale: 1 });
    expect(resolvePanelDisplayUnit({ unit: 's' })).toEqual({ unit: 's', valueScale: 1 });
    expect(resolvePanelDisplayUnit({})).toEqual({ unit: undefined, valueScale: 1 });
  });
});
