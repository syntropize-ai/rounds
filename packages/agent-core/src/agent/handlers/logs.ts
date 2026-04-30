import type { ActionContext } from './_context.js';

// ---------------------------------------------------------------------------
// Source-agnostic logs primitives — each takes `sourceId` and resolves the
// concrete adapter through `ctx.adapters.logs(sourceId)`.
// ---------------------------------------------------------------------------

const LOGS_QUERY_MAX_CHARS = 2000;

function unknownLogsSource(sourceId: string): string {
  return `Error: unknown logs datasource '${sourceId}'. Call datasources_list to see available sources.`;
}

// TODO: migrate to withToolEventBoundary
export async function handleLogsQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources_list to see available sources.';
  const adapter = ctx.adapters.logs(sourceId);
  if (!adapter) return unknownLogsSource(sourceId);
  const query = String(args.query ?? '');
  if (!query) return 'Error: "query" is required (backend-native — e.g. LogQL for Loki).';
  if (!args.start || !args.end) return 'Error: "start" and "end" (ISO-8601 timestamps) are required.';
  const start = new Date(String(args.start));
  const end = new Date(String(args.end));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Error: "start" / "end" must be valid ISO-8601 timestamps.';
  }
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(1000, args.limit)) : undefined;

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'logs_query',
    args: { sourceId, query, limit },
    displayText: `Querying logs on ${sourceId}: ${query.slice(0, 60)}`,
  });
  try {
    const result = await adapter.query({ query, start, end, ...(limit !== undefined ? { limit } : {}) });
    if (result.entries.length === 0) {
      const msg = 'Logs query returned no entries.';
      ctx.sendEvent({ type: 'tool_result', tool: 'logs_query', summary: msg, success: true });
      return msg;
    }
    // Format: `[ts] {k=v, k=v} message` — truncate the whole blob to keep the
    // observation reasonable even when the backend returns many rows.
    const lines: string[] = [];
    let shown = 0;
    let totalLen = 0;
    for (const e of result.entries) {
      const labelStr = Object.entries(e.labels).map(([k, v]) => `${k}=${v}`).join(',');
      const line = `[${e.timestamp}]${labelStr ? ` {${labelStr}}` : ''} ${e.message}`;
      if (totalLen + line.length > LOGS_QUERY_MAX_CHARS) break;
      lines.push(line);
      totalLen += line.length + 1;
      shown += 1;
    }
    const truncated = shown < result.entries.length;
    const header = truncated
      ? `${shown} of ${result.entries.length} log entries (truncated):`
      : `${result.entries.length} log entries:`;
    const partialTail = result.partial ? '\n(Backend indicated results were partial — narrow the time window or add filters for completeness.)' : '';
    const warnTail = result.warnings?.length ? `\nWarnings: ${result.warnings.join('; ')}` : '';
    const summary = `${header}\n${lines.join('\n')}${partialTail}${warnTail}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'logs_query', summary: `${result.entries.length} entries`, success: true });
    return summary;
  } catch (err) {
    const msg = `Logs query failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'logs_query', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleLogsLabels(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources_list to see available sources.';
  const adapter = ctx.adapters.logs(sourceId);
  if (!adapter) return unknownLogsSource(sourceId);
  ctx.sendEvent({ type: 'tool_call', tool: 'logs_labels', args: { sourceId }, displayText: `Listing log labels on ${sourceId}` });
  try {
    const labels = await adapter.listLabels();
    const summary = labels.length === 0 ? 'No log labels available.' : labels.join(', ');
    ctx.sendEvent({ type: 'tool_result', tool: 'logs_labels', summary: `${labels.length} labels`, success: true });
    return summary;
  } catch (err) {
    const msg = `Failed to list log labels: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'logs_labels', summary: msg, success: false });
    return msg;
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleLogsLabelValues(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '');
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources_list to see available sources.';
  const adapter = ctx.adapters.logs(sourceId);
  if (!adapter) return unknownLogsSource(sourceId);
  const label = String(args.label ?? '');
  if (!label) return 'Error: "label" is required.';
  ctx.sendEvent({ type: 'tool_call', tool: 'logs_label_values', args: { sourceId, label }, displayText: `Listing values for log label "${label}"` });
  try {
    const values = await adapter.listLabelValues(label);
    const summary = values.length === 0
      ? `No values found for label "${label}".`
      : values.slice(0, 50).join(', ') + (values.length > 50 ? ` ... and ${values.length - 50} more` : '');
    ctx.sendEvent({ type: 'tool_result', tool: 'logs_label_values', summary: `${values.length} values`, success: true });
    return summary;
  } catch (err) {
    const msg = `Failed to list log label values: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'logs_label_values', summary: msg, success: false });
    return msg;
  }
}
