/**
 * Tests for the metric_explore handler's PR-C surface:
 *   - inheriting the prior chart's timeRange when timeRangeHint is absent
 *   - emitting a stale-data warning when the prior chart is > 5 min old
 *   - computing pivot suggestions and including them in the SSE payload
 */
import { describe, it, expect, vi } from 'vitest';
import { handleMetricExplore } from '../metric-explore.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';
import type { ActionContext } from '../_context.js';

function makeAdapters(rangeQuery = vi.fn().mockResolvedValue([])): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register({
    info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
    metrics: { rangeQuery } as never,
  });
  return reg;
}

const FIXED_NOW = new Date('2026-05-13T12:00:00Z').getTime();

describe('handleMetricExplore — timeRange inheritance', () => {
  it('uses explicit timeRangeHint when provided', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const lookup = vi.fn();
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
      recentEventLookup: lookup as ActionContext['recentEventLookup'],
    });
    await handleMetricExplore(ctx, { query: 'up', timeRangeHint: '1h' });
    // Explicit hint → no inheritance lookup.
    expect(lookup).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('inherits range from the most recent inline_chart event when hint is absent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const priorEnd = new Date(FIXED_NOW - 60_000).toISOString(); // 1 min ago — fresh
    const priorStart = new Date(FIXED_NOW - 60 * 60_000 - 60_000).toISOString();
    const lookup = vi.fn().mockResolvedValue({
      payload: { timeRange: { start: priorStart, end: priorEnd } },
      timestamp: new Date(FIXED_NOW - 60_000).toISOString(),
    });
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
      recentEventLookup: lookup as ActionContext['recentEventLookup'],
    });
    await handleMetricExplore(ctx, { query: 'up' });

    const inlineChart = (ctx.sendEvent as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e?.type === 'inline_chart');
    expect(inlineChart).toBeDefined();
    expect(inlineChart.timeRange.start).toBe(priorStart);
    expect(inlineChart.timeRange.end).toBe(priorEnd);
    expect(inlineChart.warnings).toBeUndefined();
    vi.useRealTimers();
  });

  it('inherits but warns when the prior chart is stale (> 5 min ago)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const priorEnd = new Date(FIXED_NOW - 10 * 60_000).toISOString(); // 10 min ago
    const priorStart = new Date(FIXED_NOW - 70 * 60_000).toISOString();
    const lookup = vi.fn().mockResolvedValue({
      payload: { timeRange: { start: priorStart, end: priorEnd } },
      timestamp: priorEnd,
    });
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
      recentEventLookup: lookup as ActionContext['recentEventLookup'],
    });
    await handleMetricExplore(ctx, { query: 'up' });

    const inlineChart = (ctx.sendEvent as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e?.type === 'inline_chart');
    expect(inlineChart.timeRange.end).toBe(priorEnd);
    expect(inlineChart.warnings).toEqual([
      expect.stringContaining('Inherited time range from earlier chart'),
    ]);
    vi.useRealTimers();
  });

  it('falls back to default 1h when no prior chart and no hint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const lookup = vi.fn().mockResolvedValue(null);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
      recentEventLookup: lookup as ActionContext['recentEventLookup'],
    });
    await handleMetricExplore(ctx, { query: 'up' });

    const inlineChart = (ctx.sendEvent as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e?.type === 'inline_chart');
    const span =
      new Date(inlineChart.timeRange.end).getTime() -
      new Date(inlineChart.timeRange.start).getTime();
    expect(span).toBe(60 * 60_000);
    vi.useRealTimers();
  });

  it('includes pivot suggestions in the emitted inline_chart event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    await handleMetricExplore(ctx, {
      query: 'histogram_quantile(0.5, sum(rate(http_duration_bucket[5m])) by (le))',
      timeRangeHint: '1h',
    });

    const inlineChart = (ctx.sendEvent as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e?.type === 'inline_chart');
    expect(inlineChart.pivotSuggestions.length).toBeGreaterThan(0);
    expect(
      inlineChart.pivotSuggestions.every(
        (p: unknown) =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as { label?: unknown }).label === 'string' &&
          typeof (p as { prompt?: unknown }).prompt === 'string',
      ),
    ).toBe(true);
    vi.useRealTimers();
  });
});
