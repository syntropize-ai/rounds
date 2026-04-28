import type { ToolDefinition } from '@agentic-obs/llm-gateway';
import {
  TOOL_REGISTRY,
  deferredToolNamesForAgent,
} from '../tool-schema-registry.js';
import {
  TOOL_SEARCH_SELECT_PREFIX,
  formatToolSearchObservation,
  searchTools,
  selectTools,
} from '../tool-search.js';

// ---------------------------------------------------------------------------
// tool_search — resolve a model query into deferred tool schemas.
//
// react-loop.ts calls `resolveToolSearch` directly when it sees a
// `tool_search` tool_use block; the loop (not this handler) tracks the
// `loadedDeferredTools` set per session and ships the newly loaded schemas
// in the next gateway call. We expose the resolver as a plain function so
// it stays unit-testable without spinning up a full orchestrator context.
// ---------------------------------------------------------------------------

/**
 * The deferred-tool catalog the model is allowed to discover from this
 * session. Pass `allowedTools` to scope the search to one agent's surface;
 * omit to fall back to every deferred tool in the registry (useful for
 * standalone test cases).
 */
export function deferredCatalog(
  allowedTools?: readonly string[],
): Record<string, ToolDefinition> {
  const names = allowedTools
    ? deferredToolNamesForAgent(allowedTools)
    : Object.entries(TOOL_REGISTRY)
        .filter(([, entry]) => entry.category === 'deferred')
        .map(([name]) => name);
  const out: Record<string, ToolDefinition> = {};
  for (const name of names) {
    const entry = TOOL_REGISTRY[name];
    if (entry) out[name] = entry.schema;
  }
  return out;
}

export interface ToolSearchResult {
  observation: string;
  /** Names the loop should add to its `loadedDeferredTools` set so the next
   *  gateway call exposes their full schema. */
  loaded: string[];
  /** Set when the call itself was malformed (blank query, etc.) — distinct
   *  from "valid query, no matches". The loop uses this to emit success=false
   *  on the SSE event so the chat UI shows a real error rather than a green
   *  "Loaded 0 tools" trace. */
  error?: string;
}

/**
 * Resolve a `tool_search` query against the deferred-tool catalog. Returns
 * the formatted observation (mirrors Anthropic's `<functions>...</functions>`
 * shape) plus the names that the caller should now mark as loaded.
 */
export function resolveToolSearch(
  query: string,
  allowedTools?: readonly string[],
): ToolSearchResult {
  const trimmed = (query ?? '').trim();
  if (!trimmed) {
    const message =
      'Error: "query" is required. Use "select:<name>[,<name>...]" to load known tools by name, or whitespace-separated keywords to search.';
    return {
      observation: message,
      loaded: [],
      error: message,
    };
  }
  const catalog = deferredCatalog(allowedTools);
  let defs: ToolDefinition[];
  if (trimmed.toLowerCase().startsWith(TOOL_SEARCH_SELECT_PREFIX)) {
    const csv = trimmed.slice(TOOL_SEARCH_SELECT_PREFIX.length);
    defs = selectTools(csv.split(','), catalog);
  } else {
    defs = searchTools(trimmed, catalog);
  }
  return {
    observation: formatToolSearchObservation(defs),
    loaded: defs.map((d) => d.name),
  };
}
