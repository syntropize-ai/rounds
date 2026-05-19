import { describe, it, expect, vi } from 'vitest';
import {
  handleMetricsListNames,
  handleMetricsGetLabels,
  handleMetricsGetLabelValues,
  handleMetricsGetCardinality,
  handleMetricsSampleSeries,
  handleMetricsFindRelated,
} from '../metric-discovery.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';

interface FakeAdapter {
  instantQuery: ReturnType<typeof vi.fn>;
  rangeQuery: ReturnType<typeof vi.fn>;
  listLabels: ReturnType<typeof vi.fn>;
  listLabelValues: ReturnType<typeof vi.fn>;
  findSeries: ReturnType<typeof vi.fn>;
  findSeriesFull: ReturnType<typeof vi.fn>;
  fetchMetadata: ReturnType<typeof vi.fn>;
  listMetricNames: ReturnType<typeof vi.fn>;
  testQuery: ReturnType<typeof vi.fn>;
  isHealthy: ReturnType<typeof vi.fn>;
}

function makeAdapter(overrides: Partial<FakeAdapter> = {}): FakeAdapter {
  return {
    instantQuery: vi.fn().mockResolvedValue([]),
    rangeQuery: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue([]),
    listLabelValues: vi.fn().mockResolvedValue([]),
    findSeries: vi.fn().mockResolvedValue([]),
    findSeriesFull: vi.fn().mockResolvedValue([]),
    fetchMetadata: vi.fn().mockResolvedValue({}),
    listMetricNames: vi.fn().mockResolvedValue([]),
    testQuery: vi.fn().mockResolvedValue({ ok: true }),
    isHealthy: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function ctxWith(adapter: FakeAdapter, sourceId = 'prom') {
  const reg = new AdapterRegistry();
  reg.register({
    info: { id: sourceId, name: sourceId, type: 'prometheus', signalType: 'metrics', isDefault: true },
    metrics: adapter as never,
  });
  return makeFakeActionContext({
    adapters: reg,
    allConnectors: [{ id: sourceId, name: sourceId, type: 'prometheus', isDefault: true } as never],
    auditWriter: vi.fn().mockResolvedValue(undefined),
  });
}

describe('metric-discovery handlers', () => {
  // -- metrics_list_names ---------------------------------------------------
  describe('handleMetricsListNames', () => {
    it('returns all names when no match is given (happy path)', async () => {
      const adapter = makeAdapter({
        listMetricNames: vi.fn().mockResolvedValue(['up', 'http_requests_total', 'cpu_seconds']),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsListNames(ctx, { datasourceId: 'prom' });
      const parsed = JSON.parse(obs) as { names: string[]; truncated: boolean };
      expect(parsed.names).toEqual(['up', 'http_requests_total', 'cpu_seconds']);
      expect(parsed.truncated).toBe(false);
    });

    it('filters by case-insensitive regex when match is given', async () => {
      const adapter = makeAdapter({
        listMetricNames: vi.fn().mockResolvedValue(['up', 'http_requests_total', 'HTTP_errors', 'cpu']),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsListNames(ctx, { datasourceId: 'prom', match: 'http' });
      const parsed = JSON.parse(obs) as { names: string[] };
      expect(parsed.names.sort()).toEqual(['HTTP_errors', 'http_requests_total']);
    });

    it('returns no-datasource error when no connector is configured', async () => {
      const ctx = makeFakeActionContext();
      const obs = await handleMetricsListNames(ctx, {});
      expect(obs).toMatch(/no metrics datasource available/);
    });

    it('returns unknown-connector when datasourceId does not resolve', async () => {
      const ctx = makeFakeActionContext({
        allConnectors: [{ id: 'real', name: 'real', type: 'prometheus' } as never],
      });
      const obs = await handleMetricsListNames(ctx, { datasourceId: 'ghost' });
      expect(obs).toMatch(/unknown metrics connector 'ghost'/);
    });

    it('surfaces a Prom error via the SSE boundary (re-throws)', async () => {
      const adapter = makeAdapter({
        listMetricNames: vi.fn().mockRejectedValue(new Error('502 backend')),
      });
      const ctx = ctxWith(adapter);
      await expect(handleMetricsListNames(ctx, { datasourceId: 'prom' })).rejects.toThrow('502 backend');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'metrics_list_names', success: false }),
      );
    });
  });

  // -- metrics_get_labels ---------------------------------------------------
  describe('handleMetricsGetLabels', () => {
    it('returns labels list for a metric', async () => {
      const adapter = makeAdapter({
        listLabels: vi.fn().mockResolvedValue(['job', 'instance', 'method']),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsGetLabels(ctx, { datasourceId: 'prom', metricName: 'http_requests_total' });
      expect(JSON.parse(obs)).toEqual({ labels: ['job', 'instance', 'method'] });
      expect(adapter.listLabels).toHaveBeenCalledWith('http_requests_total');
    });

    it('requires metricName', async () => {
      const adapter = makeAdapter();
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsGetLabels(ctx, { datasourceId: 'prom' });
      expect(obs).toMatch(/"metricName" is required/);
    });

    it('returns no-datasource error when nothing is configured', async () => {
      const ctx = makeFakeActionContext();
      const obs = await handleMetricsGetLabels(ctx, { metricName: 'up' });
      expect(obs).toMatch(/no metrics datasource available/);
    });

    it('re-throws Prom errors through the boundary', async () => {
      const adapter = makeAdapter({
        listLabels: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const ctx = ctxWith(adapter);
      await expect(handleMetricsGetLabels(ctx, { datasourceId: 'prom', metricName: 'up' })).rejects.toThrow('boom');
    });
  });

  // -- metrics_get_label_values ---------------------------------------------
  describe('handleMetricsGetLabelValues', () => {
    it('returns deduped values from the series set, scoped to the metric', async () => {
      const adapter = makeAdapter({
        findSeriesFull: vi.fn().mockResolvedValue([
          { __name__: 'http_requests_total', method: 'GET', status: '200' },
          { __name__: 'http_requests_total', method: 'POST', status: '200' },
          { __name__: 'http_requests_total', method: 'GET', status: '500' },
        ]),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsGetLabelValues(ctx, {
        datasourceId: 'prom',
        metricName: 'http_requests_total',
        label: 'method',
      });
      const parsed = JSON.parse(obs) as { values: string[]; truncated: boolean };
      expect(parsed.values.sort()).toEqual(['GET', 'POST']);
      expect(parsed.truncated).toBe(false);
      expect(adapter.findSeriesFull).toHaveBeenCalledWith(['http_requests_total'], expect.any(Number));
    });

    it('sets truncated=true when the value count exceeds limit', async () => {
      const series = Array.from({ length: 12 }, (_, i) => ({
        __name__: 'm',
        pod: `pod-${i}`,
      }));
      const adapter = makeAdapter({
        findSeriesFull: vi.fn().mockResolvedValue(series),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsGetLabelValues(ctx, {
        datasourceId: 'prom',
        metricName: 'm',
        label: 'pod',
        limit: 5,
      });
      const parsed = JSON.parse(obs) as { values: string[]; truncated: boolean };
      expect(parsed.values).toHaveLength(5);
      expect(parsed.truncated).toBe(true);
    });

    it('requires metricName and label', async () => {
      const adapter = makeAdapter();
      const ctx = ctxWith(adapter);
      expect(await handleMetricsGetLabelValues(ctx, { datasourceId: 'prom' })).toMatch(/"metricName" is required/);
      expect(await handleMetricsGetLabelValues(ctx, { datasourceId: 'prom', metricName: 'up' })).toMatch(/"label" is required/);
    });
  });

  // -- metrics_get_cardinality ----------------------------------------------
  describe('handleMetricsGetCardinality', () => {
    it('returns the series count', async () => {
      const adapter = makeAdapter({
        findSeriesFull: vi.fn().mockResolvedValue([
          { __name__: 'm', a: '1' },
          { __name__: 'm', a: '2' },
          { __name__: 'm', a: '3' },
        ]),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsGetCardinality(ctx, { datasourceId: 'prom', metricName: 'm' });
      expect(JSON.parse(obs)).toEqual({ seriesCount: 3, truncated: false });
    });

    it('requires metricName', async () => {
      const ctx = ctxWith(makeAdapter());
      const obs = await handleMetricsGetCardinality(ctx, { datasourceId: 'prom' });
      expect(obs).toMatch(/"metricName" is required/);
    });

    it('returns unknown-connector when the source id is bogus', async () => {
      const ctx = makeFakeActionContext({
        allConnectors: [{ id: 'real', name: 'real', type: 'prometheus' } as never],
      });
      const obs = await handleMetricsGetCardinality(ctx, { datasourceId: 'ghost', metricName: 'm' });
      expect(obs).toMatch(/unknown metrics connector/);
    });
  });

  // -- metrics_sample_series ------------------------------------------------
  describe('handleMetricsSampleSeries', () => {
    it('returns each series as { labels, value } with __name__ stripped', async () => {
      const adapter = makeAdapter({
        instantQuery: vi.fn().mockResolvedValue([
          { labels: { __name__: 'm', job: 'api', instance: 'a' }, value: 1.2, timestamp: 0 },
          { labels: { __name__: 'm', job: 'api', instance: 'b' }, value: 3.4, timestamp: 0 },
        ]),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsSampleSeries(ctx, { datasourceId: 'prom', metricName: 'm' });
      const parsed = JSON.parse(obs) as { series: Array<{ labels: Record<string, string>; value: number }>; truncated: boolean };
      expect(parsed.series).toHaveLength(2);
      expect(parsed.series[0]?.labels).not.toHaveProperty('__name__');
      expect(parsed.series[0]?.labels['job']).toBe('api');
      expect(parsed.series[0]?.value).toBe(1.2);
      expect(parsed.truncated).toBe(false);
    });

    it('respects the limit and reports truncation', async () => {
      const samples = Array.from({ length: 5 }, (_, i) => ({
        labels: { __name__: 'm', i: String(i) },
        value: i,
        timestamp: 0,
      }));
      const adapter = makeAdapter({ instantQuery: vi.fn().mockResolvedValue(samples) });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsSampleSeries(ctx, { datasourceId: 'prom', metricName: 'm', limit: 2 });
      const parsed = JSON.parse(obs) as { series: unknown[]; truncated: boolean };
      expect(parsed.series).toHaveLength(2);
      expect(parsed.truncated).toBe(true);
    });

    it('requires metricName', async () => {
      const ctx = ctxWith(makeAdapter());
      const obs = await handleMetricsSampleSeries(ctx, { datasourceId: 'prom' });
      expect(obs).toMatch(/"metricName" is required/);
    });
  });

  // -- metrics_find_related -------------------------------------------------
  describe('handleMetricsFindRelated', () => {
    it('ranks other metrics by number of shared label keys', async () => {
      // Target metric `m` has labels {job, pod}.
      // Candidate findSeriesFull calls return series for OTHER metric names
      // that carry those labels.
      const adapter = makeAdapter({
        findSeriesFull: vi.fn(async (matchers: string[]) => {
          if (matchers[0] === 'm') {
            return [{ __name__: 'm', job: 'api', pod: 'p1' }];
          }
          if (matchers[0] === '{job!=""}') {
            return [
              { __name__: 'sibling_a', job: 'api' },
              { __name__: 'sibling_b', job: 'api' },
            ];
          }
          if (matchers[0] === '{pod!=""}') {
            return [{ __name__: 'sibling_a', pod: 'p1' }];
          }
          return [];
        }),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsFindRelated(ctx, { datasourceId: 'prom', metricName: 'm' });
      const parsed = JSON.parse(obs) as { related: Array<{ metric: string; sharedLabels: string[] }> };
      // sibling_a appears under both labels (job + pod) → rank 1; sibling_b only via job.
      expect(parsed.related[0]?.metric).toBe('sibling_a');
      expect(parsed.related[0]?.sharedLabels.sort()).toEqual(['job', 'pod']);
      expect(parsed.related[1]?.metric).toBe('sibling_b');
    });

    it('ignores structural labels (le, quantile, __name__)', async () => {
      const adapter = makeAdapter({
        findSeriesFull: vi.fn(async (matchers: string[]) => {
          if (matchers[0] === 'h') {
            return [{ __name__: 'h', le: '0.5', quantile: '0.9' }];
          }
          // No identifying labels → returns empty related set without
          // even issuing per-label calls.
          return [];
        }),
      });
      const ctx = ctxWith(adapter);
      const obs = await handleMetricsFindRelated(ctx, { datasourceId: 'prom', metricName: 'h' });
      const parsed = JSON.parse(obs) as { related: unknown[] };
      expect(parsed.related).toEqual([]);
      // findSeriesFull only called once — for the target metric. No per-label calls
      // were issued for le/quantile/__name__.
      expect(adapter.findSeriesFull).toHaveBeenCalledTimes(1);
    });

    it('returns no-datasource when no connector configured', async () => {
      const ctx = makeFakeActionContext();
      const obs = await handleMetricsFindRelated(ctx, { metricName: 'm' });
      expect(obs).toMatch(/no metrics datasource available/);
    });

    it('requires metricName', async () => {
      const ctx = ctxWith(makeAdapter());
      const obs = await handleMetricsFindRelated(ctx, { datasourceId: 'prom' });
      expect(obs).toMatch(/"metricName" is required/);
    });
  });

  // -- audit writer ---------------------------------------------------------
  describe('audit logging', () => {
    it('writes a metrics.query audit row with the tool name in metadata on success', async () => {
      const adapter = makeAdapter({
        listMetricNames: vi.fn().mockResolvedValue(['up']),
      });
      const auditWriter = vi.fn().mockResolvedValue(undefined);
      const reg = new AdapterRegistry();
      reg.register({
        info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
        metrics: adapter as never,
      });
      const ctx = makeFakeActionContext({
        adapters: reg,
        auditWriter,
      });
      await handleMetricsListNames(ctx, { datasourceId: 'prom' });
      // auditWriter is fire-and-forget; allow the promise microtask to flush.
      await Promise.resolve();
      expect(auditWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'metrics.query',
          targetType: 'connector',
          targetId: 'prom',
          metadata: expect.objectContaining({ tool: 'metrics_list_names', source: 'agent_tool' }),
        }),
      );
    });
  });
});
