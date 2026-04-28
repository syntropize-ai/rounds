import { describe, it, expect, vi } from 'vitest';
import {
  handleMetricsQuery,
  handleMetricsRangeQuery,
  handleMetricsDiscover,
  handleMetricsValidate,
} from '../metrics.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';

interface FakeMetricsAdapter {
  instantQuery: ReturnType<typeof vi.fn>;
  rangeQuery: ReturnType<typeof vi.fn>;
  listLabels: ReturnType<typeof vi.fn>;
  listLabelValues: ReturnType<typeof vi.fn>;
  findSeries: ReturnType<typeof vi.fn>;
  fetchMetadata: ReturnType<typeof vi.fn>;
  listMetricNames: ReturnType<typeof vi.fn>;
  testQuery: ReturnType<typeof vi.fn>;
}

function makeAdaptersWithMetrics(adapter: FakeMetricsAdapter): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register({
    info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
    metrics: adapter as never,
  });
  return reg;
}

function makeAdapter(overrides: Partial<FakeMetricsAdapter> = {}): FakeMetricsAdapter {
  return {
    instantQuery: vi.fn().mockResolvedValue([]),
    rangeQuery: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue([]),
    listLabelValues: vi.fn().mockResolvedValue([]),
    findSeries: vi.fn().mockResolvedValue([]),
    fetchMetadata: vi.fn().mockResolvedValue({}),
    listMetricNames: vi.fn().mockResolvedValue([]),
    testQuery: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe('metrics handlers', () => {
  describe('handleMetricsQuery', () => {
    it('returns formatted series and emits a successful tool_result', async () => {
      const adapter = makeAdapter({
        instantQuery: vi.fn().mockResolvedValue([
          { labels: { __name__: 'up', job: 'api' }, timestamp: 1, value: 1 },
        ]),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsQuery(ctx, { sourceId: 'prom', query: 'up' });
      expect(adapter.instantQuery).toHaveBeenCalledWith('up', undefined);
      expect(observation).toContain('job="api"');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'metrics.query', success: true }),
      );
    });

    it('returns an unknown-source error and skips the call when sourceId is not registered', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleMetricsQuery(ctx, { sourceId: 'nope', query: 'up' });
      expect(observation).toMatch(/unknown metrics datasource 'nope'/);
    });

    it('catches adapter errors and returns success: false in tool_result', async () => {
      const adapter = makeAdapter({
        instantQuery: vi.fn().mockRejectedValue(new Error('500: backend down')),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsQuery(ctx, { sourceId: 'prom', query: 'up' });
      expect(observation).toBe('Query failed: 500: backend down');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'metrics.query', success: false }),
      );
    });

    it('forwards `time` to the adapter so panel-window-anchored queries hit the right timestamp', async () => {
      const adapter = makeAdapter();
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const ts = '2026-04-25T16:00:00.000Z';
      await handleMetricsQuery(ctx, { sourceId: 'prom', query: 'up', time: ts });
      expect(adapter.instantQuery).toHaveBeenCalledWith('up', new Date(ts));
    });
  });

  describe('handleMetricsRangeQuery', () => {
    it('uses duration_minutes when start/end are absent and reports series counts', async () => {
      const adapter = makeAdapter({
        rangeQuery: vi.fn().mockResolvedValue([
          { metric: { __name__: 'cpu' }, values: [[1, '0.1'], [2, '0.2']] },
        ]),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsRangeQuery(ctx, {
        sourceId: 'prom',
        query: 'cpu',
        duration_minutes: 30,
      });
      expect(adapter.rangeQuery).toHaveBeenCalledWith('cpu', expect.any(Date), expect.any(Date), '60s');
      expect(observation).toContain('latest=0.2');
    });

    it('returns success: false when the adapter throws', async () => {
      const adapter = makeAdapter({
        rangeQuery: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsRangeQuery(ctx, { sourceId: 'prom', query: 'cpu' });
      expect(observation).toBe('Range query failed: timeout');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'metrics.range_query', success: false }),
      );
    });
  });

  describe('handleMetricsDiscover', () => {
    it('rejects missing sourceId with a helpful observation', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleMetricsDiscover(ctx, { kind: 'names' });
      expect(observation).toMatch(/requires "sourceId"/);
    });

    it('rejects missing kind by name', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom' });
      expect(observation).toMatch(/requires "kind"/);
    });

    it('rejects an unknown kind value', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'bogus' });
      expect(observation).toMatch(/unknown kind "bogus"/);
    });

    it('kind=labels returns a comma-joined label list', async () => {
      const adapter = makeAdapter({ listLabels: vi.fn().mockResolvedValue(['job', 'instance']) });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'labels' });
      expect(observation).toBe('job, instance');
    });

    it('kind=values requires `label` and surfaces the missing-arg in the error', async () => {
      const adapter = makeAdapter();
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'values' });
      expect(observation).toMatch(/kind="values" requires "label"/);
      expect(adapter.listLabelValues).not.toHaveBeenCalled();
    });

    it('kind=series passes an array selector verbatim', async () => {
      const adapter = makeAdapter({
        findSeries: vi.fn().mockResolvedValue(['up{job="a"}']),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, {
        sourceId: 'prom',
        kind: 'series',
        match: ['up{job="a"}'],
      });
      expect(adapter.findSeries).toHaveBeenCalledWith(['up{job="a"}']);
      expect(observation).toContain('up{job="a"}');
    });

    it('kind=series rejects an empty match array', async () => {
      const adapter = makeAdapter();
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'series', match: [] });
      expect(observation).toMatch(/kind="series" requires "match"/);
      expect(adapter.findSeries).not.toHaveBeenCalled();
    });

    it('kind=metadata formats entries as `name (type): help`', async () => {
      const adapter = makeAdapter({
        fetchMetadata: vi.fn().mockResolvedValue({
          up: { type: 'gauge', help: 'Was the last scrape successful' },
        }),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'metadata', metric: 'up' });
      expect(observation).toBe('up (gauge): Was the last scrape successful');
    });

    it('kind=names filters by `match` substring (case-insensitive)', async () => {
      const adapter = makeAdapter({
        listMetricNames: vi.fn().mockResolvedValue(['http_requests_total', 'cpu_seconds', 'http_errors']),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'names', match: 'HTTP' });
      expect(observation).toContain('http_requests_total');
      expect(observation).toContain('http_errors');
      expect(observation).not.toContain('cpu_seconds');
    });

    it('returns success=false in the tool_result on adapter error', async () => {
      const adapter = makeAdapter({
        listLabels: vi.fn().mockRejectedValue(new Error('backend down')),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'labels' });
      expect(observation).toMatch(/metrics\.discover \(labels\) failed: backend down/);
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'metrics.discover', success: false }),
      );
    });
  });

  describe('handleMetricsValidate', () => {
    it('marks the tool_result as success: false when the query is invalid', async () => {
      const adapter = makeAdapter({
        testQuery: vi.fn().mockResolvedValue({ ok: false, error: 'parse error' }),
      });
      const ctx = makeFakeActionContext({ adapters: makeAdaptersWithMetrics(adapter) });
      const observation = await handleMetricsValidate(ctx, { sourceId: 'prom', query: 'bogus(' });
      expect(observation).toContain('Invalid query');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'metrics.validate', success: false }),
      );
    });
  });
});
