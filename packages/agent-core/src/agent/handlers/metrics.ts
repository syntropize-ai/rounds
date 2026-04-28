import type { ActionContext } from './_context.js';

// ---------------------------------------------------------------------------
// Source-agnostic metrics primitives — each takes `sourceId` and resolves the
// concrete adapter through `ctx.adapters.metrics(sourceId)`.
// ---------------------------------------------------------------------------

function unknownMetricsSource(sourceId: string): string {
  return `Error: unknown metrics datasource '${sourceId}'. Call datasources.list to see available sources.`;
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const expr = String(args.query ?? args.expr ?? '');
  if (!expr) return 'Error: "query" is required.';

  // Optional `time` anchor — when the user is viewing a panel with a non-default
  // time range, the orchestrator passes the window-end here so the instant
  // query reflects what the panel showed instead of "now".
  const timeArg = typeof args.time === 'string' && args.time ? args.time : undefined;
  const time = timeArg ? new Date(timeArg) : undefined;
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.query', args: { sourceId, query: expr, ...(timeArg ? { time: timeArg } : {}) }, displayText: `Querying ${sourceId}: ${expr.slice(0, 80)}` });
  try {
    const results = await adapter.instantQuery(expr, time);
    const summary = results.length === 0
      ? 'Query returned no data.'
      : results.slice(0, 20).map((s) => {
          const labelStr = Object.entries(s.labels).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ');
          return `${labelStr || s.labels.__name__ || 'series'}: ${s.value}`;
        }).join('\n') + (results.length > 20 ? `\n... and ${results.length - 20} more series` : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.query', summary: `${results.length} series returned`, success: true });
    return summary;
  } catch (err) {
    const msg = `Query failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.query', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsRangeQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
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

  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.range_query', args: { sourceId, query: expr, step }, displayText: `Range query on ${sourceId}: ${expr.slice(0, 60)}` });
  try {
    const results = await adapter.rangeQuery(expr, start, end, step);
    const summary = results.length === 0
      ? 'Range query returned no data.'
      : results.slice(0, 10).map((r) => {
          const labelStr = Object.entries(r.metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ');
          const lastVal = r.values.length > 0 ? r.values[r.values.length - 1]![1] : 'N/A';
          return `${labelStr || r.metric.__name__ || 'series'}: ${r.values.length} points, latest=${lastVal}`;
        }).join('\n') + (results.length > 10 ? `\n... and ${results.length - 10} more series` : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.range_query', summary: `${results.length} series returned`, success: true });
    return summary;
  } catch (err) {
    const msg = `Range query failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.range_query', summary: msg, success: false });
    return msg;
  }
}

// ---------------------------------------------------------------------------
// metrics.discover — single discovery tool with a `kind` discriminator.
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
  fetchMetadata(metrics?: string[]): Promise<Record<string, { type: string; help: string }>>;
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
    : values.slice(0, 50).join(', ') + (values.length > 50 ? ` ... and ${values.length - 50} more` : '');
}

async function discoverSeries(adapter: MetricsAdapter, patterns: string[]): Promise<string> {
  const series = await adapter.findSeries(patterns);
  return series.length === 0
    ? 'No series matched.'
    : series.slice(0, 50).join('\n') + (series.length > 50 ? `\n... and ${series.length - 50} more` : '');
}

async function discoverMetadata(adapter: MetricsAdapter, metrics: string[] | undefined): Promise<string> {
  const metadata = await adapter.fetchMetadata(metrics);
  const entries = Object.entries(metadata);
  return entries.length === 0
    ? 'No metadata available.'
    : entries.slice(0, 30).map(([name, m]) => `${name} (${m.type}): ${m.help}`).join('\n')
      + (entries.length > 30 ? `\n... and ${entries.length - 30} more` : '');
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
    return `${totalCount} metrics available (too many to list). Showing first 50:\n${sample.join('\n')}\n\nUse metrics.discover({ sourceId, kind: "names", match: "keyword" }) to search for specific metrics.`;
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
    return 'Error: metrics.discover requires "sourceId". Call datasources.list to see available sources.';
  }

  const kindRaw = typeof args.kind === 'string' ? args.kind : '';
  if (!kindRaw) {
    return 'Error: metrics.discover requires "kind" (one of: labels, values, series, metadata, names).';
  }
  if (!DISCOVER_KINDS.has(kindRaw as DiscoverKind)) {
    return `Error: metrics.discover received unknown kind "${kindRaw}". Expected one of: labels, values, series, metadata, names.`;
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
    return 'Error: metrics.discover with kind="values" requires "label".';
  }
  if (kind === 'series' && (!matchArray || matchArray.length === 0 || !matchArray[0])) {
    return 'Error: metrics.discover with kind="series" requires "match" (non-empty array of selectors).';
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
    tool: 'metrics.discover',
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
        throw new Error(`metrics.discover: unhandled kind ${String(_exhaustive)}`);
      }
    }
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'metrics.discover',
      summary: `metrics.discover (${kind}) ok`,
      success: true,
    });
    return observation;
  } catch (err) {
    const msg = `metrics.discover (${kind}) failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.discover', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsValidate(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const expr = String(args.query ?? args.expr ?? '');
  if (!expr) return 'Error: "query" is required.';
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.validate', args: { sourceId, query: expr }, displayText: `Validating: ${expr.slice(0, 60)}` });
  try {
    const result = await adapter.testQuery(expr);
    const summary = result.ok ? `Valid query: ${expr}` : `Invalid query: ${result.error ?? 'unknown error'}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.validate', summary, success: result.ok });
    return summary;
  } catch (err) {
    const msg = `Validation failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.validate', summary: msg, success: false });
    return msg;
  }
}
