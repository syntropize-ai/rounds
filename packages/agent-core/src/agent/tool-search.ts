/**
 * Lazy tool loading — split the registry into `always-on` (sent on every
 * gateway call) and `deferred` (only sent after the model invokes
 * `tool_search` to pull the schemas it needs).
 *
 * The model sees deferred tools in the system reminder as bare names. To
 * actually call one, it must first run `tool_search` with either a keyword
 * query (`"notebook jupyter"`) or an exact-name select (`"select:Read,Edit"`).
 * The handler returns the matching schemas; the loop adds them to the
 * `loadedDeferredTools` set so subsequent gateway calls expose them.
 */

import type { ToolDefinition } from '@agentic-obs/llm-gateway';

export type ToolCategory = 'always-on' | 'deferred';

/** Cap on how many tool defs a single search returns, even if more match.
 *  Keeps the observation small enough to fit in one tool_result block. */
const MAX_RESULTS = 8;

const SELECT_PREFIX = 'select:';

/**
 * Exact-name lookup. Accepts a comma-separated list of tool names and
 * returns the matching ToolDefinitions in the order requested. Unknown names
 * are silently skipped — the handler narrates them in the observation so the
 * model can correct itself.
 *
 * Same MAX_RESULTS cap and dedupe as the keyword search so the model can't
 * accidentally inflate one observation by passing a giant or duplicated list.
 */
export function selectTools(
  names: readonly string[],
  registry: Record<string, ToolDefinition>,
): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    const def = registry[name];
    if (def) {
      out.push(def);
      seen.add(name);
      if (out.length >= MAX_RESULTS) break;
    }
  }
  return out;
}

/**
 * Keyword search over tool names + descriptions. Splits the query on
 * whitespace; a tool matches when every term appears (case-insensitively)
 * in either its name or description. Results are ranked by name-match first,
 * then by how many terms hit, then alphabetically — deterministic so tests
 * can pin order.
 */
export function searchTools(
  query: string,
  registry: Record<string, ToolDefinition>,
): ToolDefinition[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // `select:` form is a different shape — keep `searchTools` keyword-only
  // and let callers route `select:` requests through `selectTools` directly.
  // We still handle it here defensively so a caller that forgets to route
  // gets sensible behavior instead of a fuzzy search over `select:Foo`.
  if (trimmed.toLowerCase().startsWith(SELECT_PREFIX)) {
    const csv = trimmed.slice(SELECT_PREFIX.length);
    return selectTools(csv.split(','), registry);
  }

  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  type Scored = { def: ToolDefinition; nameHits: number; descHits: number };
  const scored: Scored[] = [];

  for (const def of Object.values(registry)) {
    const name = def.name.toLowerCase();
    const desc = def.description.toLowerCase();
    let nameHits = 0;
    let descHits = 0;
    let allMatched = true;
    for (const term of terms) {
      const inName = name.includes(term);
      const inDesc = desc.includes(term);
      if (!inName && !inDesc) {
        allMatched = false;
        break;
      }
      if (inName) nameHits++;
      if (inDesc) descHits++;
    }
    if (allMatched) scored.push({ def, nameHits, descHits });
  }

  scored.sort((a, b) => {
    if (a.nameHits !== b.nameHits) return b.nameHits - a.nameHits;
    if (a.descHits !== b.descHits) return b.descHits - a.descHits;
    return a.def.name.localeCompare(b.def.name);
  });

  return scored.slice(0, MAX_RESULTS).map((s) => s.def);
}

/**
 * Format a list of resolved ToolDefinitions for an observation. Mirrors the
 * `<functions>{...}</functions>` shape the model sees in real Anthropic
 * system reminders so the existing schema-loading muscle memory transfers.
 */
export function formatToolSearchObservation(defs: ToolDefinition[]): string {
  if (defs.length === 0) {
    return 'No tools matched. Refine the query or use `select:<name>` to load a known tool by exact name.';
  }
  const lines = defs.map((def) =>
    `<function>${JSON.stringify({
      description: def.description,
      name: def.name,
      parameters: def.input_schema,
    })}</function>`,
  );
  return `<functions>\n${lines.join('\n')}\n</functions>`;
}

export const TOOL_SEARCH_SELECT_PREFIX = SELECT_PREFIX;
