/**
 * Shared chart summary helper.
 *
 * Inputs a `RangeResult[]` (same shape returned by the metrics adapter — a
 * matrix of `(metric labels, [[ts, value], ...])` points) and produces a
 * `ChartSummary` — a user-facing one-liner + structured stats — that both the
 * REST endpoint `/api/metrics/query` and the agent `metric_explore` tool
 * emit. Splitting it here so a future replay/i18n surface can re-derive the
 * oneLine from `stats` if needed.
 *
 * Per-kind rules: see `summarize()` JSDoc.
 */

export type ChartMetricKind = 'latency' | 'counter' | 'gauge' | 'errors';

export interface ChartSummary {
  kind: ChartMetricKind;
  /** User-facing one-liner. Empty pieces are elided cleanly. */
  oneLine: string;
  /** Structured stats — replay/i18n surface uses this. */
  stats: Record<string, number | string>;
}

export interface SummarySeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

/** Format an HH:MM (24h) label for a unix-seconds timestamp. */
function hhmm(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function flattenPoints(series: SummarySeries[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of series) {
    for (const [ts, raw] of s.values) {
      const v = Number(raw);
      if (Number.isFinite(v)) out.push([ts, v]);
    }
  }
  return out;
}

/** Average a list of numbers. Returns 0 on empty. */
function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

/** Compact human-readable number — "1.2k", "4.8M", "73", "0.4". */
function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs >= 100) return `${Math.round(n)}`;
  if (abs >= 10) return `${n.toFixed(1)}`;
  return `${n.toFixed(2)}`;
}

/** Round to integer for ms display. */
function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

/**
 * Summarise a range-query result for the inline chart bubble.
 *
 * Per-kind rules:
 * - `latency`: assumes histogram_quantile output. Heuristic: if max value < 100
 *   the units are probably seconds and we scale by 1000 to display ms. Picks
 *   peak across ALL series (the worst-case quantile/route).
 * - `counter`: rate/sum (e.g. req/s). Reports avg and peak across the whole
 *   matrix.
 * - `gauge`: cpu/mem-style instantaneous values. Reports the latest value
 *   across all series, range (min/max), and a coarse trend (compare avg of
 *   last 1/3 of timestamps vs avg of first 1/3 across all points).
 * - `errors`: rate/count. Reports rate (avg of all points) and identifies the
 *   "noisiest" series — the one with highest cumulative sum. The label key
 *   picked for "from ..." is the non-`__name__` label with the highest
 *   cardinality across the series set (more distinct values = more
 *   discriminating). When fewer than 2 series, we drop "most from ...".
 */
export function summarize(
  series: SummarySeries[],
  kind: ChartMetricKind,
): ChartSummary {
  switch (kind) {
    case 'latency': return summarizeLatency(series);
    case 'counter': return summarizeCounter(series);
    case 'gauge': return summarizeGauge(series);
    case 'errors': return summarizeErrors(series);
  }
}

function summarizeLatency(series: SummarySeries[]): ChartSummary {
  const points = flattenPoints(series);
  if (points.length === 0) {
    return { kind: 'latency', oneLine: 'no data', stats: {} };
  }
  const max = Math.max(...points.map(([, v]) => v));
  // Heuristic: small numbers → seconds, scale to ms.
  const scaleToMs = max < 100 ? 1000 : 1;
  const valuesMs = points.map(([, v]) => v * scaleToMs);
  const avgMs = avg(valuesMs);
  // p95: sort copy, pick index.
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
  // Peak + peak timestamp.
  let peakMs = -Infinity;
  let peakTs = points[0]![0];
  for (const [ts, v] of points) {
    const vms = v * scaleToMs;
    if (vms > peakMs) { peakMs = vms; peakTs = ts; }
  }
  const peakAt = new Date(peakTs * 1000).toISOString();
  return {
    kind: 'latency',
    oneLine: `avg ${ms(avgMs)} · p95 ${ms(p95Ms)} · peak ${ms(peakMs)} at ${hhmm(peakTs)}`,
    stats: {
      avgMs: Math.round(avgMs),
      p95Ms: Math.round(p95Ms),
      peakMs: Math.round(peakMs),
      peakAt,
    },
  };
}

function summarizeCounter(series: SummarySeries[]): ChartSummary {
  const points = flattenPoints(series);
  if (points.length === 0) {
    return { kind: 'counter', oneLine: 'no data', stats: {} };
  }
  const values = points.map(([, v]) => v);
  const avgV = avg(values);
  let peak = -Infinity;
  let peakTs = points[0]![0];
  for (const [ts, v] of points) {
    if (v > peak) { peak = v; peakTs = ts; }
  }
  return {
    kind: 'counter',
    oneLine: `avg ${compactNumber(avgV)} req/s · peak ${compactNumber(peak)} at ${hhmm(peakTs)}`,
    stats: {
      avg: Number(avgV.toFixed(3)),
      peak: Number(peak.toFixed(3)),
      peakAt: new Date(peakTs * 1000).toISOString(),
    },
  };
}

function summarizeGauge(series: SummarySeries[]): ChartSummary {
  const points = flattenPoints(series);
  if (points.length === 0) {
    return { kind: 'gauge', oneLine: 'no data', stats: {} };
  }
  // "Current" = average across series of the last point per series.
  // For a single series this is just the last value.
  const lastValues: number[] = [];
  for (const s of series) {
    const last = s.values[s.values.length - 1];
    if (last) {
      const v = Number(last[1]);
      if (Number.isFinite(v)) lastValues.push(v);
    }
  }
  const current = avg(lastValues);
  const all = points.map(([, v]) => v);
  const min = Math.min(...all);
  const max = Math.max(...all);

  // Trend: compare last third avg vs first third avg across all points.
  const sortedByTs = [...points].sort((a, b) => a[0] - b[0]);
  const third = Math.max(1, Math.floor(sortedByTs.length / 3));
  const firstThirdAvg = avg(sortedByTs.slice(0, third).map(([, v]) => v));
  const lastThirdAvg = avg(sortedByTs.slice(-third).map(([, v]) => v));
  const delta = lastThirdAvg - firstThirdAvg;
  const range = max - min || 1;
  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (delta / range > 0.1) trend = 'up';
  else if (delta / range < -0.1) trend = 'down';
  const trendGlyph = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';

  return {
    kind: 'gauge',
    oneLine: `current ${compactNumber(current)} · range ${compactNumber(min)}-${compactNumber(max)} · ${trendGlyph} trend`,
    stats: {
      current: Number(current.toFixed(3)),
      min: Number(min.toFixed(3)),
      max: Number(max.toFixed(3)),
      trend,
    },
  };
}

function summarizeErrors(series: SummarySeries[]): ChartSummary {
  const points = flattenPoints(series);
  if (points.length === 0) {
    return { kind: 'errors', oneLine: 'no data', stats: {} };
  }
  const rate = avg(points.map(([, v]) => v));
  const stats: Record<string, number | string> = {
    rate: Number(rate.toFixed(3)),
  };
  let oneLine = `${compactNumber(rate)} err/s`;

  // "Most from" — only meaningful when there's more than one series.
  if (series.length >= 2) {
    // Find the discriminating label key — non-__name__ with highest cardinality.
    const labelKeyCardinality = new Map<string, Set<string>>();
    for (const s of series) {
      for (const [k, v] of Object.entries(s.metric)) {
        if (k === '__name__') continue;
        if (!labelKeyCardinality.has(k)) labelKeyCardinality.set(k, new Set());
        labelKeyCardinality.get(k)!.add(v);
      }
    }
    let topKey: string | null = null;
    let topCard = 0;
    for (const [k, vs] of labelKeyCardinality) {
      if (vs.size > topCard) { topCard = vs.size; topKey = k; }
    }

    // Find the series with the highest cumulative sum.
    let topSeries: SummarySeries | null = null;
    let topSum = -Infinity;
    for (const s of series) {
      let sum = 0;
      for (const [, raw] of s.values) {
        const v = Number(raw);
        if (Number.isFinite(v)) sum += v;
      }
      if (sum > topSum) { topSum = sum; topSeries = s; }
    }

    if (topKey && topSeries) {
      const label = topSeries.metric[topKey];
      if (label) {
        oneLine += ` · most from "${label}"`;
        stats['topLabel'] = label;
      }
    }
  }

  return { kind: 'errors', oneLine, stats };
}
