import { describe, it, expect } from 'vitest';
import { AdapterRegistry, type AdapterEntry } from './registry.js';
import type { IMetricsAdapter } from './metrics-adapter.js';
import type { ILogsAdapter } from './logs-adapter.js';
import type { IChangesAdapter } from './changes-adapter.js';

/**
 * Minimal stubs — we don't test adapter behavior here, only that the
 * registry hands back the right instance.
 */
const metricsStub: IMetricsAdapter = {
  listMetricNames: async () => [],
  listLabels: async () => [],
  listLabelValues: async () => [],
  findSeries: async () => [],
  findSeriesFull: async () => [],
  fetchMetadata: async () => ({}),
  instantQuery: async () => [],
  rangeQuery: async () => [],
  testQuery: async () => ({ ok: true }),
  isHealthy: async () => true,
};

const logsStub: ILogsAdapter = {
  query: async () => ({ entries: [], partial: false }),
  listLabels: async () => [],
  listLabelValues: async () => [],
  isHealthy: async () => true,
};

const changesStub: IChangesAdapter = {
  listRecent: async () => [],
};

function metricsEntry(id: string, name: string): AdapterEntry {
  return {
    info: { id, name, type: 'prometheus', signalType: 'metrics' },
    metrics: metricsStub,
  };
}

function logsEntry(id: string, name: string): AdapterEntry {
  return {
    info: { id, name, type: 'loki', signalType: 'logs' },
    logs: logsStub,
  };
}

function changesEntry(id: string, name: string): AdapterEntry {
  return {
    info: { id, name, type: 'change-event', signalType: 'changes' },
    changes: changesStub,
  };
}

describe('AdapterRegistry', () => {
  it('register + get round-trip returns the same entry', () => {
    const r = new AdapterRegistry();
    const entry = metricsEntry('prom-1', 'Prod Prometheus');
    r.register(entry);
    expect(r.get('prom-1')).toBe(entry);
  });

  it('get returns undefined for missing sourceId', () => {
    const r = new AdapterRegistry();
    expect(r.get('nope')).toBeUndefined();
  });

  it('list() without filter returns all info sorted by name', () => {
    const r = new AdapterRegistry();
    r.register(metricsEntry('b', 'Beta'));
    r.register(metricsEntry('a', 'Alpha'));
    r.register(logsEntry('c', 'Charlie'));

    const names = r.list().map((d) => d.name);
    expect(names).toEqual(['Alpha', 'Beta', 'Charlie']);
  });

  it('list({ signalType }) filters by signal type', () => {
    const r = new AdapterRegistry();
    r.register(metricsEntry('m1', 'Metrics One'));
    r.register(logsEntry('l1', 'Logs One'));
    r.register(changesEntry('ch1', 'Changes One'));

    const metricsOnly = r.list({ signalType: 'metrics' });
    expect(metricsOnly.map((d) => d.id)).toEqual(['m1']);

    const logsOnly = r.list({ signalType: 'logs' });
    expect(logsOnly.map((d) => d.id)).toEqual(['l1']);

    const changesOnly = r.list({ signalType: 'changes' });
    expect(changesOnly.map((d) => d.id)).toEqual(['ch1']);
  });

  it('list() returns empty array when registry empty', () => {
    const r = new AdapterRegistry();
    expect(r.list()).toEqual([]);
    expect(r.list({ signalType: 'metrics' })).toEqual([]);
  });

  it('typed accessors return the correct adapter instance', () => {
    const r = new AdapterRegistry();
    r.register(metricsEntry('m1', 'M1'));
    r.register(logsEntry('l1', 'L1'));
    r.register(changesEntry('ch1', 'Ch1'));

    expect(r.metrics('m1')).toBe(metricsStub);
    expect(r.logs('l1')).toBe(logsStub);
    expect(r.changes('ch1')).toBe(changesStub);
  });

  it('typed accessors return undefined when sourceId points at wrong signal type', () => {
    const r = new AdapterRegistry();
    r.register(metricsEntry('m1', 'M1'));
    r.register(logsEntry('l1', 'L1'));

    expect(r.logs('m1')).toBeUndefined();
    expect(r.changes('m1')).toBeUndefined();
    expect(r.metrics('l1')).toBeUndefined();
    expect(r.changes('l1')).toBeUndefined();
  });

  it('typed accessors return undefined when sourceId is unknown', () => {
    const r = new AdapterRegistry();
    expect(r.metrics('missing')).toBeUndefined();
    expect(r.logs('missing')).toBeUndefined();
    expect(r.changes('missing')).toBeUndefined();
  });

  it('register throws when the same sourceId is registered twice', () => {
    const r = new AdapterRegistry();
    r.register(metricsEntry('dup', 'Dup'));
    expect(() => r.register(metricsEntry('dup', 'Dup Again'))).toThrow(
      /already registered/,
    );
  });
});
