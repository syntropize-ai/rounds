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

// TODO: migrate to withToolEventBoundary
export async function handleMetricsLabels(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const metric = String(args.metric ?? '');
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.labels', args: { sourceId, metric }, displayText: `Listing labels${metric ? ` for ${metric}` : ''}` });
  try {
    const labels = await adapter.listLabels(metric);
    const summary = labels.length === 0 ? `No labels found${metric ? ` for ${metric}` : ''}.` : labels.join(', ');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.labels', summary: `${labels.length} labels`, success: true });
    return summary;
  } catch (err) {
    const msg = `Failed to list labels: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.labels', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsLabelValues(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const label = String(args.label ?? '');
  if (!label) return 'Error: "label" is required.';
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.label_values', args: { sourceId, label }, displayText: `Listing values for label "${label}"` });
  try {
    const values = await adapter.listLabelValues(label);
    const summary = values.length === 0
      ? `No values found for label "${label}".`
      : values.slice(0, 50).join(', ') + (values.length > 50 ? ` ... and ${values.length - 50} more` : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.label_values', summary: `${values.length} values`, success: true });
    return summary;
  } catch (err) {
    const msg = `Failed to list label values: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.label_values', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsSeries(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const rawMatch = args.match ?? args.patterns ?? args.pattern;
  const patterns = Array.isArray(rawMatch) ? rawMatch.map(String) : [String(rawMatch ?? '')];
  if (patterns.length === 0 || !patterns[0]) return 'Error: "match" (array of selectors) is required.';
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.series', args: { sourceId, match: patterns }, displayText: `Finding series matching: ${patterns.join(', ').slice(0, 60)}` });
  try {
    const series = await adapter.findSeries(patterns);
    const summary = series.length === 0
      ? 'No series matched.'
      : series.slice(0, 50).join('\n') + (series.length > 50 ? `\n... and ${series.length - 50} more` : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.series', summary: `${series.length} series found`, success: true });
    return summary;
  } catch (err) {
    const msg = `Series search failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.series', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsMetadata(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const metric = typeof args.metric === 'string' ? args.metric : undefined;
  const metrics = metric ? [metric] : (Array.isArray(args.metrics) ? args.metrics.map(String) : undefined);
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.metadata', args: { sourceId, metric: metric ?? metrics ?? 'all' }, displayText: `Fetching metadata${metric ? ` for ${metric}` : ''}` });
  try {
    const metadata = await adapter.fetchMetadata(metrics);
    const entries = Object.entries(metadata);
    const summary = entries.length === 0
      ? 'No metadata available.'
      : entries.slice(0, 30).map(([name, m]) => `${name} (${m.type}): ${m.help}`).join('\n')
        + (entries.length > 30 ? `\n... and ${entries.length - 30} more` : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metadata', summary: `${entries.length} metrics`, success: true });
    return summary;
  } catch (err) {
    const msg = `Metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metadata', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleMetricsMetricNames(ctx: ActionContext, args: Record<string, unknown> = {}): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.';
  const adapter = ctx.adapters.metrics(sourceId);
  if (!adapter) return unknownMetricsSource(sourceId);
  const filter = typeof args.match === 'string'
    ? args.match.toLowerCase()
    : typeof args.filter === 'string'
      ? args.filter.toLowerCase()
      : undefined;

  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.metric_names', args: { sourceId, ...(filter ? { match: filter } : {}) }, displayText: filter ? `Searching metrics matching "${filter}"` : 'Listing metric names' });
  try {
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
      const summary = `${totalCount} metrics available (too many to list). Showing first 50:\n${sample.join('\n')}\n\nUse metrics.metric_names({ sourceId, match: "keyword" }) to search for specific metrics.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metric_names', summary: `${totalCount} metrics (sampled)`, success: true });
      return summary;
    }

    const truncationNote = truncated
      ? ` (showing first 500 of ${matchCount} matches; refine the filter for more)`
      : '';
    const summary = names.length === 0
      ? filter ? `No metrics matching "${filter}" (${totalCount} total metrics in cluster).` : 'No metrics found.'
      : `${names.length} metrics${filter ? ` matching "${filter}"` : ''}${truncationNote} (${totalCount} total).\n` + names.join('\n');
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metric_names', summary: `${names.length} metrics`, success: true });
    return summary;
  } catch (err) {
    const msg = `Failed to list metrics: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metric_names', summary: msg, success: false });
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
