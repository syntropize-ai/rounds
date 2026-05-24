/**
 * Tests for the `panel_preview` handler.
 *
 * Covers:
 *   - happy path: queries return data; ok=true; per-query sample populated
 *   - no datasource configured → ok=false with a clear error issue
 *   - empty result on every query → ok=true with a "0 series" WARN
 *     (pre-deployment dashboards are a legitimate state)
 *   - multi-query mixed status: one fails, one succeeds → ok=false (the
 *     failure dominates) with both perQuery entries populated
 *   - viz-rule warnings (stat+rate; heatmap without `by (le)`)
 */
import { describe, it, expect, vi } from 'vitest';
import { handlePanelPreview, runPanelPreviewProgrammatic } from '../panel-preview.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';

function makeAdapters(rangeQueryMock: ReturnType<typeof vi.fn>): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register({
    info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
    metrics: { rangeQuery: rangeQueryMock } as never,
  });
  return reg;
}

const SAMPLE_SERIES = [
  { metric: { job: 'api', le: '0.1' }, values: [[1700000000, '1'], [1700000300, '2']] as Array<[number, string]> },
];

describe('panel_preview — happy path', () => {
  it('returns ok=true with a sample series for a single-query time_series panel', async () => {
    const rangeQuery = vi.fn().mockResolvedValue(SAMPLE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const result = await runPanelPreviewProgrammatic(ctx, {
      panel: {
        title: 'Request rate',
        visualization: 'time_series',
        queries: [{ expr: 'sum(rate(http_requests_total[5m]))' }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.perQuery).toHaveLength(1);
    expect(result.perQuery[0]!.resultLen).toBe(1);
    expect(result.perQuery[0]!.sampleSeries).toBeDefined();
    expect(result.perQuery[0]!.sampleSeries![0]!.firstValue).toBe(1);
    expect(result.perQuery[0]!.sampleSeries![0]!.lastValue).toBe(2);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

describe('panel_preview — error paths', () => {
  it('returns ok=false when no metrics datasource is configured', async () => {
    const ctx = makeFakeActionContext({
      adapters: new AdapterRegistry(),
      allConnectors: [],
    });
    const result = await runPanelPreviewProgrammatic(ctx, {
      panel: {
        title: 'X',
        visualization: 'time_series',
        queries: [{ expr: 'up' }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.message).toContain('No metrics datasource');
  });

  it('returns ok=true with a "0 series" warning when every query returns 0 series (pre-deploy)', async () => {
    const rangeQuery = vi.fn().mockResolvedValue([]);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const result = await runPanelPreviewProgrammatic(ctx, {
      panel: {
        title: 'X',
        visualization: 'time_series',
        queries: [{ expr: 'nonexistent_metric' }],
      },
    });
    // Empty results are a legitimate pre-deployment state — the gate must NOT
    // block. The warning is still emitted so the agent can mention it.
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('0 series'))).toBe(true);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('mixed multi-query: one succeeds, one fails → ok=false; both perQuery entries present', async () => {
    let call = 0;
    const rangeQuery = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) return SAMPLE_SERIES;
      throw new Error('boom: parse error');
    });
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const result = await runPanelPreviewProgrammatic(ctx, {
      panel: {
        title: 'Mixed',
        visualization: 'time_series',
        queries: [{ expr: 'sum(rate(a[5m]))' }, { expr: '!!broken' }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.perQuery).toHaveLength(2);
    expect(result.perQuery[0]!.resultLen).toBe(1);
    expect(result.perQuery[1]!.error).toContain('boom');
  });
});

describe('panel_preview — viz-rule warnings', () => {
  it('warns when stat panel uses rate()', async () => {
    const rangeQuery = vi.fn().mockResolvedValue(SAMPLE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const result = await runPanelPreviewProgrammatic(ctx, {
      panel: {
        title: 'Rate as stat',
        visualization: 'stat',
        queries: [{ expr: 'sum(rate(http_requests_total[5m]))' }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('stat'))).toBe(true);
  });

  it('warns when heatmap query lacks `by (le)`', async () => {
    const rangeQuery = vi.fn().mockResolvedValue(SAMPLE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const result = await runPanelPreviewProgrammatic(ctx, {
      panel: {
        title: 'Latency heatmap',
        visualization: 'heatmap',
        queries: [{ expr: 'rate(http_request_duration_seconds_bucket[5m])' }],
      },
    });
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('by (le)'))).toBe(true);
  });
});

describe('handlePanelPreview — observation + SSE emission', () => {
  it('emits tool_call + tool_result and returns a JSON-encoded report', async () => {
    const rangeQuery = vi.fn().mockResolvedValue(SAMPLE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const out = await handlePanelPreview(ctx, {
      panel: {
        title: 'OK panel',
        visualization: 'time_series',
        queries: [{ expr: 'up' }],
      },
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    const events = (ctx.sendEvent as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events.some((e) => e.type === 'tool_call' && e.tool === 'panel_preview')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.tool === 'panel_preview')).toBe(true);
  });

  it('rejects bad input shape with a clear error before touching the adapter', async () => {
    const rangeQuery = vi.fn();
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const out = await handlePanelPreview(ctx, { panel: { visualization: 'time_series', queries: [{ expr: 'up' }] } });
    expect(out).toContain('panel.title is required');
    expect(rangeQuery).not.toHaveBeenCalled();
  });
});
