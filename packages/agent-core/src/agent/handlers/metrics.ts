import type { ActionContext } from './_context.js';

// ---------------------------------------------------------------------------
// Source-agnostic metrics primitives — each takes `sourceId` and resolves the
// concrete adapter through `ctx.adapters.metrics(sourceId)`.
// ---------------------------------------------------------------------------

function unknownMetricsSource(sourceId: string): string {
  return `Error: unknown metrics connector '${sourceId}'. Call connectors_list to see available sources.`;
}

function moreSeriesHint(count: number): string {
  return `\n... and ${count} more series - aggregate the query (sum/avg by a label) if you need the whole series back`;
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call connectors_list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const expr = String(args.query ?? args.expr ?? '');
  if (!expr) return 'Error: "query" is required.';

  // Optional `time` anchor — when the user is viewing a panel with a non-default
  // time range, the orchestrator passes the window-end here so the instant
  // query reflects what the panel showed instead of "now".
  const timeArg = typeof args.time === 'string' && args.time ? args.time : undefined;
  const time = timeArg ? new Date(timeArg) : undefined;
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics_query', args: { sourceId, query: expr, ...(timeArg ? { time: timeArg } : {}) }, displayText: `Querying ${sourceId}: ${expr.slice(0, 80)}` });
  try {
    const results = await adapter.instantQuery(expr, time);
    const summary = results.length === 0
      ? 'Query returned no data.'
      : results.slice(0, 200).map((s) => {
          const labelStr = Object.entries(s.labels).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ');
          return `${labelStr || s.labels.__name__ || 'series'}: ${s.value}`;
        }).join('\n') + (results.length > 200 ? moreSeriesHint(results.length - 200) : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics_query', summary: `${results.length} series returned` });
    return summary;
  } catch (err) {
    const msg = `Query failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics_query', summary: msg });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsRangeQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call connectors_list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const expr = String(args.query ?? args.expr ?? '');
  if (!expr) return 'Error: "query" is required.';
  const step = String(args.step ?? '60s');

  // Two input modes: (start, end) explicit ISO strings, or duration_minutes.
  let start: Date;
  let end: Date;
  if (args.start && args.end) {
    start = new Date(String(args.start));
    end = new Date(String(args.end));
  } else {
    const durationMin = Number(args.duration_minutes ?? 60);
    end = new Date();
    start = new Date(end.getTime() - durationMin * 60_000);
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'metrics_range_query', args: { sourceId, query: expr, step }, displayText: `Range query on ${sourceId}: ${expr.slice(0, 60)}` });
  try {
    const results = await adapter.rangeQuery(expr, start, end, step);
    const summary = results.length === 0
      ? 'Range query returned no data.'
      : results.slice(0, 100).map((r) => {
          const labelStr = Object.entries(r.metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ');
          const lastVal = r.values.length > 0 ? r.values[r.values.length - 1]![1] : 'N/A';
          return `${labelStr || r.metric.__name__ || 'series'}: ${r.values.length} points, latest=${lastVal}`;
        }).join('\n') + (results.length > 100 ? moreSeriesHint(results.length - 100) : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics_range_query', summary: `${results.length} series returned` });
    return summary;
  } catch (err) {
    const msg = `Range query failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics_range_query', summary: msg });
    return msg;
  }
}

// ---------------------------------------------------------------------------
// metrics_discover — single discovery tool with a `kind` discriminator.
//
// Collapses the previous five tools (metrics.labels, metrics.label_values,
// metrics.series, metrics.metadata, metrics.metric_names) so the model picks
// the activity by argument instead of guessing among five sibling names.
// ---------------------------------------------------------------------------

type DiscoverKind = 'labels' | 'values' | 'series' | 'metadata' | 'names';

const DISCOVER_KINDS: ReadonlySet<DiscoverKind> = new Set(['labels', 'values', 'series', 'metadata', 'names']);

interface MetricsAdapter {
  listLabels(metric?: string): Promise<string[]>;
  listLabelValues(label: string): Promise<string[]>;
  findSeries(patterns: string[]): Promise<string[]>;
  fetchMetadata(metrics?: string[]): Promise<Record<string, { type: string; help: string; unit?: string }>>;
  listMetricNames(): Promise<string[]>;
}

async function discoverLabels(adapter: MetricsAdapter, metric?: string): Promise<string> {
  const labels = await adapter.listLabels(metric);
  return labels.length === 0
    ? `No labels found${metric ? ` for ${metric}` : ''}.`
    : labels.join(', ');
}

async function discoverLabelValues(adapter: MetricsAdapter, label: string): Promise<string> {
  const values = await adapter.listLabelValues(label);
  return values.length === 0
    ? `No values found for label "${label}".`
    : values.slice(0, 100).join(', ') + (values.length > 100 ? ` ... and ${values.length - 100} more values - refine the label selector if you need all values` : '');
}

async function discoverSeries(adapter: MetricsAdapter, patterns: string[]): Promise<string> {
  const series = await adapter.findSeries(patterns);
  return series.length === 0
    ? 'No series matched.'
    : series.slice(0, 200).join('\n') + (series.length > 200 ? moreSeriesHint(series.length - 200) : '');
}

async function discoverMetadata(adapter: MetricsAdapter, metrics: string[] | undefined): Promise<string> {
  const metadata = await adapter.fetchMetadata(metrics);
  const entries = Object.entries(metadata);
  return entries.length === 0
    ? 'No metadata available.'
    : entries.slice(0, 150).map(([name, m]) => {
        const fields = [m.type, m.unit ? `unit=${m.unit}` : ''].filter(Boolean).join(', ');
        return `${name} (${fields}): ${m.help}`;
      }).join('\n')
      + (entries.length > 150 ? `\n... and ${entries.length - 150} more metric names - refine the filter if you need all names` : '');
}

async function discoverNames(adapter: MetricsAdapter, filter: string | undefined): Promise<string> {
  const allNames = await adapter.listMetricNames();
  const totalCount = allNames.length;

  let names: string[];
  let matchCount = 0;
  let truncated = false;
  if (filter) {
    const matched = allNames.filter((n) => n.toLowerCase().includes(filter));
    matchCount = matched.length;
    // Broad filters like "http" can return thousands of names; cap the
    // returned slice the same way the unfiltered branch does so we don't
    // dump a multi-megabyte observation back into the LLM context.
    if (matched.length > 500) {
      names = matched.slice(0, 500);
      truncated = true;
    } else {
      names = matched;
    }
  } else if (totalCount <= 500) {
    names = allNames;
  } else {
    const sample = allNames.slice(0, 50);
    return `${totalCount} metrics available (too many to list). Showing first 50:\n${sample.join('\n')}\n\nUse metrics_discover({ sourceId, kind: "names", match: "keyword" }) to search for specific metrics.`;
  }

  const truncationNote = truncated
    ? ` (showing first 500 of ${matchCount} matches; refine the filter for more)`
    : '';
  return names.length === 0
    ? filter ? `No metrics matching "${filter}" (${totalCount} total metrics in cluster).` : 'No metrics found.'
    : `${names.length} metrics${filter ? ` matching "${filter}"` : ''}${truncationNote} (${totalCount} total).\n` + names.join('\n');
}

export async function handleMetricsDiscover(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const sourceId = typeof args.sourceId === 'string' ? args.sourceId : '';
  if (!sourceId) {
    return 'Error: metrics_discover requires "sourceId". Call connectors_list to see available sources.';
  }

  const kindRaw = typeof args.kind === 'string' ? args.kind : '';
  if (!kindRaw) {
    return 'Error: metrics_discover requires "kind" (one of: labels, values, series, metadata, names).';
  }
  if (!DISCOVER_KINDS.has(kindRaw as DiscoverKind)) {
    return `Error: metrics_discover received unknown kind "${kindRaw}". Expected one of: labels, values, series, metadata, names.`;
  }
  const kind = kindRaw as DiscoverKind;

  const metric = typeof args.metric === 'string' ? args.metric : undefined;
  const label = typeof args.label === 'string' ? args.label : undefined;
  const rawMatch = args.match;
  const matchArray = Array.isArray(rawMatch) ? rawMatch.map((m) => String(m)) : undefined;
  const matchString = typeof rawMatch === 'string' ? rawMatch : undefined;

  // Per-kind required-arg validation. Error messages name the missing arg so
  // the LLM can retry without guessing.
  if (kind === 'values' && !label) {
    return 'Error: metrics_discover with kind="values" requires "label".';
  }
  if (kind === 'series' && (!matchArray || matchArray.length === 0 || !matchArray[0])) {
    return 'Error: metrics_discover with kind="series" requires "match" (non-empty array of selectors).';
  }
  // kind='metadata' with neither `metric` nor `metrics` is valid — it asks the
  // backend for everything it knows. We don't gate that explicitly.

  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);

  const filterForNames = matchString ? matchString.toLowerCase()
    : typeof args.filter === 'string' ? args.filter.toLowerCase()
      : undefined;

  // Build a per-kind display string so the chat UI doesn't just say "Discovering names".
  const displayText = (() => {
    switch (kind) {
      case 'labels': return metric ? `Discovering labels for ${metric}` : 'Discovering labels';
      case 'values': return `Discovering values for label "${label}"`;
      case 'series': return `Discovering series matching: ${(matchArray ?? []).join(', ').slice(0, 60)}`;
      case 'metadata': return metric ? `Discovering metadata for ${metric}` : 'Discovering metadata';
      case 'names': return filterForNames ? `Discovering metrics matching "${filterForNames}"` : 'Discovering metric names';
    }
  })();

  // We don't use withToolEventBoundary here because the legacy per-kind
  // handlers caught backend errors and returned them as observation strings
  // (success=false in the SSE event) rather than throwing. The model treats
  // a discovery failure as recoverable — refine the selector and retry — so
  // we preserve that shape rather than letting the runner emit the
  // "Do NOT retry — use reply" wrapper.
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'metrics_discover',
    args: {
      sourceId,
      kind,
      ...(metric ? { metric } : {}),
      ...(label ? { label } : {}),
      ...(matchArray ? { match: matchArray } : {}),
      ...(matchString && !matchArray ? { match: matchString } : {}),
    },
    displayText,
  });
  try {
    let observation: string;
    switch (kind) {
      case 'labels':
        observation = await discoverLabels(adapter, metric);
        break;
      case 'values':
        // `label` is non-undefined here — guarded above.
        observation = await discoverLabelValues(adapter, label as string);
        break;
      case 'series':
        observation = await discoverSeries(adapter, matchArray as string[]);
        break;
      case 'metadata': {
        const metrics = metric
          ? [metric]
          : Array.isArray(args.metrics) ? args.metrics.map((m) => String(m)) : undefined;
        observation = await discoverMetadata(adapter, metrics);
        break;
      }
      case 'names':
        observation = await discoverNames(adapter, filterForNames);
        break;
      default: {
        // Defensive: DISCOVER_KINDS membership was already checked above, so
        // this branch is unreachable. The exhaustiveness check keeps a future
        // contributor honest if a new DiscoverKind is added without a case.
        const _exhaustive: never = kind;
        throw new Error(`metrics_discover: unhandled kind ${String(_exhaustive)}`);
      }
    }
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'metrics_discover',
      summary: `metrics_discover (${kind}) ok`,
    });
    ctx.dashboardBuildEvidence.metricDiscoveryCount += 1;
    return observation;
  } catch (err) {
    const msg = `metrics_discover (${kind}) failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics_discover', summary: msg });
    return msg;
  }
}

// ---------------------------------------------------------------------------
// metrics_validate — evidence-based. A query that merely parses is not
// necessarily correct: a collapsed `by (...)` grouping, a ratio that should be
// 0..1 but reads 12, or a cardinality blow-up all "run" fine. Rather than
// returning a bare valid/invalid verdict, we run the query and report the
// actual result shape (series count, labels, sample values, collapse flag) and
// let the model judge it against its own intent.
// ---------------------------------------------------------------------------

interface RangeSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

/** Compact human-readable number — `1.2k`, `3.4M`, `0.5`, `12` — for sample magnitudes. */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return 'NaN';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (abs === 0) return '0';
  if (abs >= 1) return n.toFixed(2).replace(/\.00$/, '');
  return n.toPrecision(2);
}

/**
 * Describe a range-query result so the model can judge it against intent.
 * Reports series count, the union of label keys present, per-series
 * last/min/max (capped at 8 rows), and a factual collapse flag when a label
 * named in a `by (...)` clause is absent from the result.
 */
function describeRangeResult(expr: string, series: RangeSeries[]): string {
  if (series.length === 0) {
    return [
      '0 series — the query ran but returned nothing.',
      'Common causes: a label filter that matches no series, a time window with no samples, or a metric not scraped yet (pre-deployment).',
      'Read this against what you intended — if you expected data here, the selector or grouping is likely wrong.',
    ].join(' ');
  }

  const labelKeys = [
    ...new Set(series.flatMap((s) => Object.keys(s.metric).filter((k) => k !== '__name__'))),
  ];

  const byLabels = [
    ...new Set(
      [...expr.matchAll(/\bby\s*\(([^)]*)\)/gi)]
        .flatMap((m) => (m[1] ?? '').split(','))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
  const missingByLabels = byLabels.filter((l) => !labelKeys.includes(l));

  const rows = series.slice(0, 8).map((s) => {
    const labelStr = Object.entries(s.metric)
      .filter(([k]) => k !== '__name__')
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');
    const name = labelStr || s.metric.__name__ || 'series';
    const nums = s.values.map(([, v]) => Number(v)).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return `- ${name}: (no numeric samples)`;
    const last = nums[nums.length - 1]!;
    return `- ${name}: last=${fmtNum(last)} min=${fmtNum(Math.min(...nums))} max=${fmtNum(Math.max(...nums))}`;
  });
  const moreRows = series.length > 8 ? `\n- ... and ${series.length - 8} more series` : '';

  const lines: string[] = [];
  if (missingByLabels.length > 0) {
    const labelWord = missingByLabels.length > 1 ? 'those labels are' : 'that label is';
    lines.push(
      `⚠️ Grouped by ${missingByLabels.map((l) => `\`${l}\``).join(', ')}, but ${labelWord} not on the result — the grouping collapsed. Labels actually present: ${labelKeys.length ? labelKeys.join(', ') : '(none)'}.`,
    );
  }
  lines.push(`${series.length} series. Labels present: ${labelKeys.length ? labelKeys.join(', ') : '(none)'}.`);
  lines.push(rows.join('\n') + moreRows);
  lines.push(
    'Read this against what you intended — series count, the labels you grouped/legend-formatted on, and whether the magnitudes/units make sense. A query that merely runs is not necessarily correct.',
  );
  return lines.join('\n');
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsValidate(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call connectors_list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const expr = String(args.query ?? args.expr ?? '');
  if (!expr) return 'Error: "query" is required.';
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics_validate', args: { sourceId, query: expr }, displayText: `Validating: ${expr.slice(0, 60)}` });
  try {
    // testQuery catches genuine parse/exec errors. A query that fails here
    // never ran, so there's no result shape to report.
    const result = await adapter.testQuery(expr);
    if (!result.ok) {
      const summary = `Query failed to run: ${result.error ?? 'unknown error'}`;
      ctx.sendEvent({ type: 'tool_result', tool: 'metrics_validate', summary });
      return summary;
    }

    const end = new Date();
    const start = new Date(end.getTime() - 5 * 60_000);
    const series = (await adapter.rangeQuery(expr, start, end, '60s')) as RangeSeries[];

    // Record into evidence so the dashboard_add_panels "must validate first"
    // gate keeps working — the gate keys on the expression, not the verdict.
    ctx.dashboardBuildEvidence.validatedQueries.add(expr);

    const labelKeys = [
      ...new Set(series.flatMap((s) => Object.keys(s.metric).filter((k) => k !== '__name__'))),
    ];
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'metrics_validate',
      summary: `${series.length} series; labels: ${labelKeys.length ? labelKeys.join(', ') : '(none)'}`,
    });
    return describeRangeResult(expr, series);
  } catch (err) {
    const msg = `Query failed to run: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics_validate', summary: msg });
    return msg;
  }
}
