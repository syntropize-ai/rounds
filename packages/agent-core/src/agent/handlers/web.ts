import type { ActionContext } from './_context.js';

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleWebSearch(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  // Validate inputs and emit a tool_call/tool_result pair even on early-exit
  // paths — the chat panel renders nothing for a tool_call without a matching
  // tool_result, which leaves the user staring at a stuck spinner.
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const rawMax = args.max_results ?? args.maxResults ?? 8;
  const maxResults =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(Math.floor(rawMax), 50)
      : 8;

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'web_search',
    args: { query, max_results: maxResults },
    displayText: query ? `Searching: ${query.slice(0, 60)}` : 'Searching the web',
  });

  if (!ctx.webSearchAdapter) {
    const msg = 'Error: No web search adapter configured.';
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: msg, success: false });
    return msg;
  }
  if (!query) {
    const msg = 'Error: "query" is required and must be a non-empty string.';
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: msg, success: false });
    return msg;
  }
  if (
    args.max_results !== undefined &&
    !(typeof args.max_results === 'number' && Number.isFinite(args.max_results) && args.max_results > 0)
  ) {
    const msg = 'Error: "max_results" must be a finite positive number.';
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: msg, success: false });
    return msg;
  }

  try {
    const results = await ctx.webSearchAdapter.search(query, maxResults);
    const summary = results.length === 0
      ? 'No results found.'
      : results.map((r) => `${r.title ?? 'Result'}: ${r.snippet}${r.url ? ` (${r.url})` : ''}`).join('\n\n');
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: `${results.length} results`, success: results.length > 0 });
    return summary;
  } catch (err) {
    const msg = `Web search failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: msg, success: false });
    return msg;
  }
}
