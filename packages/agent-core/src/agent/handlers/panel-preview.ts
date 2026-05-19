/**
 * `panel_preview` — server-side render + validation pass for a single panel
 * spec, *before* it lands in a saved dashboard.
 *
 * Companion to the authoring protocol section in `orchestrator-prompt.ts`:
 * the model drafts a panel, calls `panel_preview` to verify the queries
 * actually return data and the viz/query combo makes sense, fixes issues,
 * then proceeds to `dashboard_add_panels`.
 *
 * Backend-side, the same handler is invoked by the verify-gate wrapped
 * around `dashboard_add_panels` (see `runPanelPreviewProgrammatic`) so
 * even a misbehaving agent that skips the protocol still hits the safety
 * net before persisting.
 */

import {
  AuditAction,
  extractPanelMetricNames,
  resolvePanelUnit,
  summarizeChart,
  type ChartMetricKind,
  type PanelMetricMetadata,
} from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { pickStep, inferKind } from './metric-explore.js';

const RELATIVE_RANGE_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export type PanelPreviewVisualization =
  | 'time_series' | 'stat' | 'bar' | 'heatmap' | 'gauge' | 'table';

export interface PanelPreviewQuery {
  expr: string;
  legendFormat?: string;
  instant?: boolean;
}

export interface PanelPreviewSpec {
  title: string;
  description?: string;
  visualization: PanelPreviewVisualization;
  queries: PanelPreviewQuery[];
  unit?: string;
}

export interface PanelPreviewArgs {
  datasourceId?: string;
  panel: PanelPreviewSpec;
  timeRange?:
    | { from: number; to: number }
    | { relative: keyof typeof RELATIVE_RANGE_MS };
}

export type PanelPreviewSeverity = 'error' | 'warn' | 'info';

export interface PanelPreviewIssue {
  severity: PanelPreviewSeverity;
  message: string;
  fixHint?: string;
}

export interface PerQueryResult {
  expr: string;
  resultLen: number;
  sampleSeries?: Array<{
    labels: Record<string, string>;
    firstValue: number;
    lastValue: number;
  }>;
  error?: string;
}

export interface PanelPreviewResult {
  ok: boolean;
  issues: PanelPreviewIssue[];
  perQuery: PerQueryResult[];
  suggestedUnit?: string;
  inlineChart?: {
    query: string;
    datasourceId: string;
    timeRange: { start: string; end: string };
    step: string;
    metricKind: ChartMetricKind;
    series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
    summary: { kind: ChartMetricKind; oneLine: string; stats: Record<string, number | string> };
  };
}

/**
 * Resolve the metrics datasource id — explicit > session pin > primary.
 * Duplicated (intentionally) from metric-explore.ts to keep the handler
 * self-contained and avoid widening that file's exports for one call site.
 */
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

function resolveTimeRange(input: PanelPreviewArgs['timeRange'], nowMs: number): { start: Date; end: Date } {
  if (input && 'relative' in input) {
    const ms = RELATIVE_RANGE_MS[input.relative] ?? RELATIVE_RANGE_MS['1h']!;
    return { start: new Date(nowMs - ms), end: new Date(nowMs) };
  }
  if (input && 'from' in input && 'to' in input) {
    return { start: new Date(input.from), end: new Date(input.to) };
  }
  // Default: last 1h.
  return { start: new Date(nowMs - RELATIVE_RANGE_MS['1h']!), end: new Date(nowMs) };
}

function isRateLikeExpr(expr: string): boolean {
  return /\brate\s*\(|\birate\s*\(|\bincrease\s*\(/.test(expr);
}

function hasByLe(expr: string): boolean {
  return /by\s*\(\s*[^)]*\ble\b[^)]*\)/.test(expr);
}

async function fetchPreviewMetadata(
  ctx: ActionContext,
  datasourceId: string,
  panel: PanelPreviewSpec,
): Promise<Record<string, PanelMetricMetadata>> {
  const metricNames = extractPanelMetricNames({ title: panel.title, queries: panel.queries });
  if (metricNames.length === 0) return {};
  const adapter = ctx.adapters.metrics(datasourceId);
  if (!adapter?.fetchMetadata) return {};
  try {
    return await adapter.fetchMetadata(metricNames);
  } catch {
    return {};
  }
}

/**
 * Convert a raw {@link PanelPreviewArgs} into a fully resolved spec. Returns
 * an error string when input is malformed — handlers return this as the
 * observation (the LLM reads + adjusts).
 */
function parseArgs(raw: Record<string, unknown>): PanelPreviewArgs | string {
  const panel = raw['panel'] as Record<string, unknown> | undefined;
  if (!panel || typeof panel !== 'object') {
    return 'Error: "panel" object is required.';
  }
  const title = typeof panel['title'] === 'string' ? panel['title'].trim() : '';
  if (!title) return 'Error: panel.title is required.';
  const visualization = panel['visualization'] as PanelPreviewVisualization | undefined;
  const VIZ: ReadonlySet<string> = new Set([
    'time_series', 'stat', 'bar', 'heatmap', 'gauge', 'table',
  ]);
  if (!visualization || !VIZ.has(visualization)) {
    return 'Error: panel.visualization must be one of time_series, stat, bar, heatmap, gauge, table.';
  }
  const queriesRaw = panel['queries'];
  if (!Array.isArray(queriesRaw) || queriesRaw.length === 0) {
    return 'Error: panel.queries[] must contain at least one query.';
  }
  const queries: PanelPreviewQuery[] = [];
  for (const q of queriesRaw) {
    const obj = q as Record<string, unknown>;
    const expr = typeof obj?.['expr'] === 'string' ? (obj['expr'] as string).trim() : '';
    if (!expr) return 'Error: every query must have a non-empty expr.';
    queries.push({
      expr,
      legendFormat: typeof obj['legendFormat'] === 'string' ? obj['legendFormat'] as string : undefined,
      instant: obj['instant'] === true,
    });
  }
  const spec: PanelPreviewSpec = {
    title,
    description: typeof panel['description'] === 'string' ? panel['description'] as string : undefined,
    visualization,
    queries,
    unit: typeof panel['unit'] === 'string' ? panel['unit'] as string : undefined,
  };

  let timeRange: PanelPreviewArgs['timeRange'];
  const tr = raw['timeRange'] as Record<string, unknown> | undefined;
  if (tr && typeof tr === 'object') {
    if (typeof tr['relative'] === 'string') {
      timeRange = { relative: tr['relative'] as 'relative' extends never ? never : keyof typeof RELATIVE_RANGE_MS };
    } else if (typeof tr['from'] === 'number' && typeof tr['to'] === 'number') {
      timeRange = { from: tr['from'], to: tr['to'] };
    }
  }
  return {
    datasourceId: typeof raw['datasourceId'] === 'string' ? raw['datasourceId'] as string : undefined,
    panel: spec,
    ...(timeRange ? { timeRange } : {}),
  };
}

/**
 * Core preview logic — used by both the tool handler and the verify-gate
 * wrapper around dashboard writes. Pure function of (ctx, spec): no SSE
 * emission, no audit write. Callers decide whether to publish + audit.
 */
export async function runPanelPreviewProgrammatic(
  ctx: ActionContext,
  args: PanelPreviewArgs,
): Promise<PanelPreviewResult> {
  const issues: PanelPreviewIssue[] = [];
  const perQuery: PerQueryResult[] = [];

  const datasourceId = resolveDatasourceId(ctx, args.datasourceId);
  if (!datasourceId) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: 'No metrics datasource available. Configure a prometheus/victoria-metrics connector first.' }],
      perQuery: [],
    };
  }
  const adapter = ctx.adapters.metrics(datasourceId);
  if (!adapter) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: `Unknown metrics connector "${datasourceId}".` }],
      perQuery: [],
    };
  }

  const nowMs = Date.now();
  const range = resolveTimeRange(args.timeRange, nowMs);
  const step = pickStep(range.start, range.end);

  let totalSeries = 0;
  for (const q of args.panel.queries) {
    try {
      const series = await adapter.rangeQuery(q.expr, range.start, range.end, step);
      const sample = series.slice(0, 3).map((s) => {
        const values = s.values;
        const first = values.length > 0 ? Number(values[0]![1]) : NaN;
        const last = values.length > 0 ? Number(values[values.length - 1]![1]) : NaN;
        return { labels: s.metric, firstValue: first, lastValue: last };
      });
      const entry: PerQueryResult = { expr: q.expr, resultLen: series.length };
      if (sample.length > 0) entry.sampleSeries = sample;
      perQuery.push(entry);
      totalSeries += series.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      perQuery.push({ expr: q.expr, resultLen: 0, error: msg });
      issues.push({
        severity: 'error',
        message: `Query failed: ${q.expr.slice(0, 80)} — ${msg}`,
        fixHint: 'Re-run metrics_discover to confirm the metric and labels exist before retrying.',
      });
    }
  }

  // Rule 3: all queries empty.
  if (perQuery.length > 0 && perQuery.every((p) => p.resultLen === 0 && !p.error)) {
    issues.push({
      severity: 'error',
      message: 'All queries returned 0 series — the panel would render blank.',
      fixHint: 'Re-check label selectors with metrics_discover (kind=label_values), widen the time range, or pick a different metric.',
    });
  }

  // Rule 4: stat + rate() warns — counters via rate render poorly in a single number.
  if (args.panel.visualization === 'stat') {
    const anyRate = args.panel.queries.some((q) => isRateLikeExpr(q.expr));
    if (anyRate) {
      issues.push({
        severity: 'warn',
        message: 'stat panel with rate()/increase() shows a single instantaneous value; trends are lost.',
        fixHint: 'Use time_series for rate over time, or set instant=true and acknowledge it shows only the latest evaluation.',
      });
    }
  }

  // Rule 5: heatmap without `by (le)` — buckets won't group correctly.
  if (args.panel.visualization === 'heatmap') {
    const lacksLe = args.panel.queries.every((q) => !hasByLe(q.expr));
    if (lacksLe) {
      issues.push({
        severity: 'warn',
        message: 'heatmap queries should be sum by (le) (rate(<metric>_bucket[5m])). Without `by (le)` the heatmap renders as a single solid band.',
        fixHint: 'Wrap the bucket metric: sum by (le) (rate(metric_name_bucket[5m])).',
      });
    }
  }

  // Rule 6: bar viz with a time series (>1 series and many points) — likely wrong.
  if (args.panel.visualization === 'bar') {
    const multi = perQuery.some((p) => p.resultLen > 1 && (p.sampleSeries?.[0]?.firstValue !== p.sampleSeries?.[0]?.lastValue));
    if (multi) {
      issues.push({
        severity: 'info',
        message: 'bar visualization renders snapshot values; multi-series time data may be misleading.',
        fixHint: 'Switch to time_series, or restrict with topk(N, ...) + set instant=true.',
      });
    }
  }

  const ok = issues.every((i) => i.severity !== 'error');
  const metadataByMetric = await fetchPreviewMetadata(ctx, datasourceId, args.panel);
  const suggestedUnit = resolvePanelUnit({
    title: args.panel.title,
    unit: args.panel.unit,
    queries: args.panel.queries,
    metadataByMetric,
  });
  const result: PanelPreviewResult = { ok, issues, perQuery };
  if (suggestedUnit) result.suggestedUnit = suggestedUnit;

  // Build an inline chart for the first query (single-query case only — multi
  // query panels can't be represented in a single inline_chart bubble).
  if (ok && args.panel.queries.length === 1 && totalSeries > 0) {
    const onlyQ = args.panel.queries[0]!;
    try {
      const series = await adapter.rangeQuery(onlyQ.expr, range.start, range.end, step);
      const kind = inferKind(onlyQ.expr);
      const summary = summarizeChart(series, kind);
      result.inlineChart = {
        query: onlyQ.expr,
        datasourceId,
        timeRange: { start: range.start.toISOString(), end: range.end.toISOString() },
        step,
        metricKind: kind,
        series,
        summary,
      };
    } catch {
      // Already captured in perQuery — inline chart is best-effort.
    }
  }

  return result;
}

export async function handlePanelPreview(
  ctx: ActionContext,
  rawArgs: Record<string, unknown>,
): Promise<string> {
  const parsed = parseArgs(rawArgs);
  if (typeof parsed === 'string') return parsed;

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'panel_preview',
    args: { title: parsed.panel.title, visualization: parsed.panel.visualization, queryCount: parsed.panel.queries.length },
    displayText: `Previewing panel: "${parsed.panel.title}"`,
  });

  const result = await runPanelPreviewProgrammatic(ctx, parsed);

  // Audit (fire-and-forget) — same shape as metric_explore for the MetricsQuery
  // action; metadata.tool distinguishes the call site.
  if (ctx.auditWriter) {
    const datasourceId = resolveDatasourceId(ctx, parsed.datasourceId) ?? '';
    void ctx.auditWriter({
      action: AuditAction.MetricsQuery,
      actorType: 'user',
      actorId: ctx.identity.userId,
      orgId: ctx.identity.orgId,
      targetType: 'connector',
      targetId: datasourceId,
      outcome: result.ok ? 'success' : 'failure',
      metadata: {
        tool: 'panel_preview',
        panelTitle: parsed.panel.title,
        visualization: parsed.panel.visualization,
        queryCount: parsed.panel.queries.length,
        issueCount: result.issues.length,
        source: 'agent_tool',
        sessionId: ctx.sessionId,
      },
    });
  }

  ctx.sendEvent({
    type: 'tool_result',
    tool: 'panel_preview',
    summary: result.ok
      ? `panel_preview ok — ${result.perQuery.reduce((s, p) => s + p.resultLen, 0)} series across ${result.perQuery.length} query/queries`
      : `panel_preview found ${result.issues.filter((i) => i.severity === 'error').length} error(s)`,
    success: result.ok,
  });

  // Return a compact text observation. The model gets the structured JSON
  // inlined as text — it's small (≤ a few KB) and the agent needs both the
  // ok flag and the per-issue messages to decide what to do next.
  return JSON.stringify(result, null, 2);
}
