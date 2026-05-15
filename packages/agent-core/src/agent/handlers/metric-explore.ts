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

import { AuditAction, summarizeChart, type ChartMetricKind } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';

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
  const range = parseTimeRangeHint(hint, Date.now());
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
    const summary = summarizeChart(series, kind);

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
      pivotSuggestions: [],
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
      success: true,
    });

    // The model gets the one-liner only — chart data goes to the UI.
    // Suffix the parse warning when we fell back to default 1h.
    return range.warning ? `${summary.oneLine} (${range.warning})` : summary.oneLine;
  } catch (err) {
    const msg = `metric_explore failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'metric_explore',
      summary: msg,
      success: false,
    });
    return msg;
  }
}
