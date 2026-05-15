import { describe, it, expect } from 'vitest';
import { summarize, type SummarySeries } from './chart-summary.js';

// Helper: build a series from a list of [unixSec, value] tuples.
function s(metric: Record<string, string>, values: Array<[number, number]>): SummarySeries {
  return { metric, values: values.map(([ts, v]) => [ts, String(v)]) };
}

describe('summarize', () => {
  it('latency: scales seconds to ms via heuristic and reports avg/p95/peak', () => {
    // Values in seconds — max 0.34, all < 100, so we scale to ms.
    const series = [
      s({ quantile: '0.5' }, [
        [1700000000, 0.1],
        [1700000060, 0.12],
        [1700000120, 0.14],
      ]),
      s({ quantile: '0.95' }, [
        [1700000000, 0.2],
        [1700000060, 0.34], // peak — at ts=1700000060 (14:14 UTC)
        [1700000120, 0.24],
      ]),
    ];
    const out = summarize(series, 'latency');
    expect(out.kind).toBe('latency');
    expect(out.oneLine).toMatch(/avg \d+ms · p95 \d+ms · peak \d+ms at \d{2}:\d{2}/);
    expect(out.stats['peakMs']).toBe(340);
    expect(typeof out.stats['peakAt']).toBe('string');
    expect(out.stats['avgMs']).toBeGreaterThan(0);
    expect(out.stats['p95Ms']).toBeGreaterThanOrEqual(out.stats['avgMs'] as number);
  });

  it('latency: keeps ms scale when values already look like ms (max >= 100)', () => {
    const series = [
      s({}, [
        [1700000000, 120],
        [1700000060, 240],
      ]),
    ];
    const out = summarize(series, 'latency');
    expect(out.stats['peakMs']).toBe(240);
  });

  it('counter: reports avg + peak with req/s units', () => {
    const series = [
      s({ route: '/api' }, [
        [1700000000, 1000],
        [1700000060, 4800],
        [1700000120, 1200],
      ]),
    ];
    const out = summarize(series, 'counter');
    expect(out.kind).toBe('counter');
    expect(out.oneLine).toMatch(/avg [\d.]+k? req\/s · peak [\d.]+k? at \d{2}:\d{2}/);
    expect(out.stats['peak']).toBe(4800);
    expect(out.stats['avg']).toBeCloseTo(7000 / 3, 2);
  });

  it('gauge: trend up when values rise across the window', () => {
    const series = [
      s({ host: 'a' }, [
        [1700000000, 50],
        [1700000060, 55],
        [1700000120, 60],
        [1700000180, 70],
        [1700000240, 75],
        [1700000300, 80],
      ]),
    ];
    const out = summarize(series, 'gauge');
    expect(out.kind).toBe('gauge');
    expect(out.stats['trend']).toBe('up');
    expect(out.stats['min']).toBe(50);
    expect(out.stats['max']).toBe(80);
    expect(out.oneLine).toContain('↑');
  });

  it('gauge: trend flat when values stay in a narrow band', () => {
    const series = [
      s({}, [
        [1700000000, 50],
        [1700000060, 51],
        [1700000120, 50],
        [1700000180, 51],
        [1700000240, 50],
        [1700000300, 51],
      ]),
    ];
    const out = summarize(series, 'gauge');
    expect(out.stats['trend']).toBe('flat');
  });

  it('errors: picks the noisiest series label as "most from"', () => {
    const series = [
      s({ route: '/api/checkout' }, [
        [1700000000, 10],
        [1700000060, 14],
      ]),
      s({ route: '/api/health' }, [
        [1700000000, 1],
        [1700000060, 0],
      ]),
    ];
    const out = summarize(series, 'errors');
    expect(out.kind).toBe('errors');
    expect(out.oneLine).toContain('err/s');
    expect(out.oneLine).toContain('"/api/checkout"');
    expect(out.stats['topLabel']).toBe('/api/checkout');
  });

  it('errors: drops "most from" when there is only one series', () => {
    const series = [s({}, [[1700000000, 12], [1700000060, 12]])];
    const out = summarize(series, 'errors');
    expect(out.oneLine).not.toContain('most from');
    expect(out.stats['topLabel']).toBeUndefined();
  });

  it('returns "no data" for empty series', () => {
    for (const kind of ['latency', 'counter', 'gauge', 'errors'] as const) {
      const out = summarize([], kind);
      expect(out.oneLine).toBe('no data');
    }
  });
});
