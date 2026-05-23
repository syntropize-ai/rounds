/**
 * `metric_explore` — query a metric and render an inline chart bubble in chat.
 *
 * Companion to the REST `/api/metrics/query` endpoint: same summary helper,
 * same wire payload shape, but emitted as an SSE `inline_chart` event so the
 * chat surface picks it up and renders a chart inline. The model receives
 * only the one-liner summary as its observation — series data goes only to
 * the UI.
 *
 * v1 omits `pivotSuggestions` (PR-C will populate them based on the metric's
 * label set + a small LLM scaffolding pass).
 */

import {
  AuditAction,
  suggestPivots,
  summarizeChart,
  type ChartMetricKind,
} from '@agentic-obs/common';
import type { ActionContext } from './_context.js';

/** How fresh the prior chart's end must be to inherit silently (no warning). */
const INHERIT_FRESH_WINDOW_MS = 5 * 60 * 1000;

const RELATIVE_HINT_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

interface ParsedRange {
  start: Date;
  end: Date;
  warning?: string;
}

/**
 * Parse a `timeRangeHint` into a concrete (start, end) pair.
 *
 * Supports:
 *   - "1h" / "6h" / "24h" / "7d"        → end=now, start=end-N
 *   - "since 14:00" / "since 9:30"      → start=today HH:MM (local), end=now
 *   - "30m around 14:23"                → ±15 minutes around the anchor today
 *   - empty / unparseable               → default 1h with a warning
 */
export function parseTimeRangeHint(hint: string | undefined, nowMs: number): ParsedRange {
  const cleaned = (hint ?? '').trim().toLowerCase();
  if (!cleaned) {
    return { start: new Date(nowMs - RELATIVE_HINT_MS['1h']!), end: new Date(nowMs) };
  }

  const relMs = RELATIVE_HINT_MS[cleaned];
  if (relMs) {
    return { start: new Date(nowMs - relMs), end: new Date(nowMs) };
  }

  // "since HH:MM"
  const sinceMatch = cleaned.match(/^since\s+(\d{1,2}):(\d{2})$/);
  if (sinceMatch) {
    const hour = Number(sinceMatch[1]);
    const minute = Number(sinceMatch[2]);
    if (hour < 24 && minute < 60) {
      const anchor = new Date(nowMs);
      anchor.setHours(hour, minute, 0, 0);
      // If the anchor is in the future (e.g. "since 23:00" at 02:00) roll
      // back one day.
      if (anchor.getTime() > nowMs) anchor.setDate(anchor.getDate() - 1);
      return { start: anchor, end: new Date(nowMs) };
    }
  }

  // "Nm around HH:MM"
  const aroundMatch = cleaned.match(/^(\d+)m\s+around\s+(\d{1,2}):(\d{2})$/);
  if (aroundMatch) {
    const span = Number(aroundMatch[1]);
    const hour = Number(aroundMatch[2]);
    const minute = Number(aroundMatch[3]);
    if (span > 0 && hour < 24 && minute < 60) {
      const anchor = new Date(nowMs);
      anchor.setHours(hour, minute, 0, 0);
      const halfMs = (span * 60_000) / 2;
      return {
        start: new Date(anchor.getTime() - halfMs),
        end: new Date(anchor.getTime() + halfMs),
      };
    }
  }

  return {
    start: new Date(nowMs - RELATIVE_HINT_MS['1h']!),
    end: new Date(nowMs),
    warning: `Couldn't parse timeRangeHint "${hint}". Defaulted to last 1h.`,
  };
}

/**
 * Pick a step targeting ~150 points across the range, snapped to a fixed set.
 * Identical to the REST endpoint's `pickStep` — duplicated to avoid making
 * api-gateway depend on agent-core (other direction is already paid for).
 */
export function pickStep(start: Date, end: Date): string {
  const seconds = Math.max(1, Math.floor((end.getTime() - start.getTime()) / 1000));
  const target = Math.floor(seconds / 150);
  const buckets = [15, 30, 60, 5 * 60, 15 * 60, 60 * 60];
  for (const b of buckets) {
    if (target <= b) return `${b}s`;
  }
  return `${buckets[buckets.length - 1]}s`;
}

/**
 * Classify a PromQL expression into a chart kind. Same heuristic as the REST
 * route's `inferKind` — duplicated here for the same reason as `pickStep`.
 */
export function inferKind(query: string): ChartMetricKind {
  const q = query.toLowerCase();
  if (q.includes('histogram_quantile')) return 'latency';
  if (/_errors?\b|5xx|status=~?"5/.test(q)) return 'errors';
  if (/\brate\s*\(|\bsum\s*\(\s*rate\s*\(/.test(q)) return 'counter';
  return 'gauge';
}

const VALID_KINDS: ReadonlySet<ChartMetricKind> = new Set([
  'latency', 'counter', 'gauge', 'errors',
]);

function hasFiniteSamples(
  series: Array<{ values: Array<[number, string]> }>,
): boolean {
  return series.some((s) =>
    s.values.some(([, raw]) => Number.isFinite(Number.parseFloat(raw))),
  );
}

/** Resolve the metrics datasource id — explicit > session pin > primary. */
function resolveDatasourceId(
  ctx: ActionContext,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  const pin = ctx.sessionConnectorPins?.['prometheus'];
  if (pin) return pin;
  const conns = ctx.allConnectors ?? [];
  const metrics = conns.filter(
    (c) => c.type === 'prometheus' || c.type === 'victoria-metrics',
  );
  if (metrics.length === 0) return undefined;
  const primary = metrics.find((c) => c.isDefault) ?? metrics[0];
  return primary?.id;
}

/**
 * Look up the most recent `inline_chart` event in this session and return
 * its timeRange. When the chart is older than `INHERIT_FRESH_WINDOW_MS`, the
 * range is still inherited but a `warning` is attached so the UI can
 * surface it. Returns `null` when no prior chart exists or the lookup is
 * not wired.
 */
export async function tryInheritRange(
  ctx: ActionContext,
  nowMs: number,
): Promise<{ range: ParsedRange; warning?: string } | null> {
  if (!ctx.recentEventLookup) return null;
  try {
    const prior = await ctx.recentEventLookup('inline_chart');
    if (!prior) return null;
    const tr = (prior.payload['timeRange'] as { start?: unknown; end?: unknown } | undefined);
    const startStr = typeof tr?.start === 'string' ? tr.start : '';
    const endStr = typeof tr?.end === 'string' ? tr.end : '';
    if (!startStr || !endStr) return null;
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const ageMs = nowMs - end.getTime();
    const range: ParsedRange = { start, end };
    if (ageMs > INHERIT_FRESH_WINDOW_MS) {
      const minutes = Math.round(ageMs / 60_000);
      return {
        range,
        warning: `Inherited time range from earlier chart (${minutes} min ago)`,
      };
    }
    return { range };
  } catch {
    // Lookup failures should never break the handler — fall back to default.
    return null;
  }
}

export async function handleMetricExplore(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (!query) {
    return 'Error: "query" is required.';
  }
  const datasourceId = resolveDatasourceId(
    ctx,
    typeof args['datasourceId'] === 'string' ? args['datasourceId'] : undefined,
  );
  if (!datasourceId) {
    return 'Error: no metrics datasource available. Call connectors_list to see what is configured.';
  }
  const adapter = ctx.adapters.metrics(datasourceId);
  if (!adapter) {
    return `Error: unknown metrics connector '${datasourceId}'.`;
  }

  const hint = typeof args['timeRangeHint'] === 'string' ? args['timeRangeHint'] : undefined;
  const nowMs = Date.now();
  const parsed = parseTimeRangeHint(hint, nowMs);
  // Inherit prior chart's range when the LLM didn't supply an explicit hint
  // (parseTimeRangeHint falls back to "1h" — distinguishable by `hint` being
  // absent or the warning marker on garbage input).
  const hintAbsent = !hint || hint.trim() === '';
  const inherited = hintAbsent ? await tryInheritRange(ctx, nowMs) : null;
  const range = inherited?.range ?? parsed;
  const warnings: string[] = [];
  if (inherited?.warning) warnings.push(inherited.warning);
  const step = pickStep(range.start, range.end);

  const kindInput = typeof args['metricKind'] === 'string' ? args['metricKind'] as ChartMetricKind : undefined;
  const kind = kindInput && VALID_KINDS.has(kindInput) ? kindInput : inferKind(query);

  const displayText = `Charting ${kind}: ${query.slice(0, 80)}`;
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'metric_explore',
    args: { datasourceId, query, kind, step },
    displayText,
  });

  try {
    const series = await adapter.rangeQuery(query, range.start, range.end, step);
    if (!hasFiniteSamples(series)) {
      const summary = `No data returned for query "${query}" in the selected time range.`;

      if (ctx.auditWriter) {
        void ctx.auditWriter({
          action: AuditAction.MetricsQuery,
          actorType: 'user',
          actorId: ctx.identity.userId,
          targetType: 'connector',
          targetId: datasourceId,
          outcome: 'success',
          metadata: {
            orgId: ctx.identity.orgId,
            query: query.slice(0, 500),
            step,
            source: 'agent_tool',
            sessionId: ctx.sessionId,
            noData: true,
          },
        });
      }

      ctx.sendEvent({
        type: 'tool_result',
        tool: 'metric_explore',
        summary,
      });
      return summary;
    }

    const summary = summarizeChart(series, kind);
    const pivotSuggestions = suggestPivots({ query, metricKind: kind, summary });

    // Emit the inline chart bubble payload.
    ctx.sendEvent({
      type: 'inline_chart',
      query,
      datasourceId,
      timeRange: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      },
      step,
      metricKind: kind,
      series,
      summary,
      pivotSuggestions,
      ...(warnings.length > 0 ? { warnings } : {}),
    });

    // Audit (fire-and-forget). Mirrors the REST endpoint's audit row.
    if (ctx.auditWriter) {
      void ctx.auditWriter({
        action: AuditAction.MetricsQuery,
        actorType: 'user',
        actorId: ctx.identity.userId,
        targetType: 'connector',
        targetId: datasourceId,
        outcome: 'success',
        metadata: {
          orgId: ctx.identity.orgId,
          query: query.slice(0, 500),
          step,
          source: 'agent_tool',
          sessionId: ctx.sessionId,
        },
      });
    }

    ctx.sendEvent({
      type: 'tool_result',
      tool: 'metric_explore',
      summary: summary.oneLine,
    });

    // Build a richer observation than just the one-liner. The chart pixels
    // go to the UI; the model can't see them, so it would otherwise be
    // forced to reason from a heuristic single-line summary alone. That
    // failed badly on counter-reset metrics (envoy_server_uptime: one pod
    // restarts, summary shows "range 5–6.3k" → model reads "min 5s
    // therefore below 300s threshold" — wrong, that 5 is a restart, not
    // an alerting condition).
    //
    // The structured per-series breakdown lets the model see: this query
    // returned N series, here are the actual min/max/last per series and
    // the timestamps — so it can spot "one series collapsed to 0 at
    // 23:53 while the rest are unchanged" instead of trusting an
    // averaged range.
    const observation = buildModelObservation(query, summary, series, range.warning);
    return observation;
  } catch (err) {
    const msg = `metric_explore failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'metric_explore',
      summary: msg,
    });
    return msg;
  }
}

/**
 * Metric names whose value drops to zero on process restart — uptime
 * counters, boot-time timestamps, process-start timestamps. Plotting them
 * raw is misleading: a clean restart looks like a catastrophic drop and a
 * naive min-aggregation will report the post-restart value as the "low".
 * When the query references one of these, we append a footer so the model
 * doesn't conclude "value crashed below threshold" when the real story
 * is "the process restarted".
 */
const RESTART_SENSITIVE_NAME_RE =
  /\b\w*_uptime\b|\b\w*_start_time(?:_seconds)?\b|\b\w*_boot_time(?:_seconds)?\b/;

/** ISO-8601 minutes (no seconds) — enough resolution for "when did it dip". */
function isoMinute(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
}

/**
 * Compact representation of one series: label set + how many points + the
 * first/last/min/max values with their timestamps. The model uses this to
 * spot per-series patterns the one-line summary smudges away (one series
 * crashed at 23:53; the others are unchanged → counter reset, not alert).
 */
interface SeriesDigest {
  labels: string;
  count: number;
  first: { ts: string; value: number };
  last: { ts: string; value: number };
  min: { ts: string; value: number };
  max: { ts: string; value: number };
}

function digestSeries(s: { metric: Record<string, string>; values: Array<[number, string]> }): SeriesDigest | null {
  if (s.values.length === 0) return null;
  let min: [number, number] = [s.values[0]![0], Number(s.values[0]![1])];
  let max: [number, number] = [s.values[0]![0], Number(s.values[0]![1])];
  for (const [ts, raw] of s.values) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (v < min[1]) min = [ts, v];
    if (v > max[1]) max = [ts, v];
  }
  const firstRaw = s.values[0]!;
  const lastRaw = s.values[s.values.length - 1]!;
  const labels = Object.entries(s.metric)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${v}"`)
    .join(',') || '(no labels)';
  return {
    labels,
    count: s.values.length,
    first: { ts: isoMinute(firstRaw[0]), value: Number(firstRaw[1]) },
    last: { ts: isoMinute(lastRaw[0]), value: Number(lastRaw[1]) },
    min: { ts: isoMinute(min[0]), value: min[1] },
    max: { ts: isoMinute(max[0]), value: max[1] },
  };
}

const MAX_SERIES_LINES = 10;

/**
 * Render the per-series digest as a multi-line observation for the model.
 * Falls back to just the one-liner when there are no series. Adds a
 * counter-reset note for restart-sensitive metric names.
 */
function buildModelObservation(
  query: string,
  summary: { oneLine: string },
  series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>,
  warning: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(summary.oneLine);
  if (warning) lines.push(`(${warning})`);

  if (series.length === 0) {
    return lines.join('\n');
  }

  const digests = series.map(digestSeries).filter((d): d is SeriesDigest => d !== null);
  const shown = digests.slice(0, MAX_SERIES_LINES);
  const hidden = digests.length - shown.length;
  lines.push('');
  lines.push(`per-series (${digests.length}${hidden > 0 ? `, showing ${shown.length}` : ''}):`);
  for (const d of shown) {
    lines.push(
      `  ${d.labels} | n=${d.count} | first=${d.first.value} last=${d.last.value} min=${d.min.value}@${d.min.ts} max=${d.max.value}@${d.max.ts}`,
    );
  }
  if (hidden > 0) {
    lines.push(`  … ${hidden} more series omitted`);
  }

  if (RESTART_SENSITIVE_NAME_RE.test(query)) {
    lines.push('');
    lines.push(
      'note: this metric resets to 0 when the process restarts. Sudden drops in min/last are restart events, not low-value alert conditions. To detect actual restart frequency use `changes(<metric>[5m])` or `resets(<metric>[5m])` instead of raw value.',
    );
  }

  return lines.join('\n');
}
