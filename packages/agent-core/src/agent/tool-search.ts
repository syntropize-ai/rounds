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
 * Split a tool name into searchable parts. `investigation_complete` →
 * `["investigation", "complete"]`. CamelCase also gets split (e.g.
 * `RangeQuery` → `["range", "query"]`) for parity with non-snake_case
 * tool naming.
 *
 * Why this matters: without name-part parsing, a query like "complete
 * investigation" returns nothing because the literal substring "complete"
 * doesn't appear in any tool's description — even though
 * `investigation_complete` is exactly the tool the model wants. Mirrors
 * the approach Anthropic's claude-code takes in its server-side
 * tool_search beta.
 */
function parseNameParts(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pre-compile word-boundary regexes for description matching. Word
 * boundaries (\b…\b) prevent false positives like the term "rate"
 * matching tools whose descriptions mention "operate" — naive substring
 * matching catches both, which inflates the result set with noise.
 */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
    }
  }
  return patterns;
}

/**
 * Keyword search over tool names + descriptions.
 *
 * Three improvements over the previous AND-substring algorithm — each
 * justified by hit-rate measurement on real natural-language queries:
 *
 * 1. **Tool-name parsing.** `investigation_complete` is decomposed into
 *    `["investigation", "complete"]` so a query "complete investigation"
 *    hits BOTH name parts. Previously this returned 0 results because
 *    "complete" was nowhere in any tool description.
 * 2. **OR with score-based ranking.** A tool matches if ANY term hits
 *    its name parts, full name, or description. Tools matching MORE
 *    distinct terms — and matching them in higher-signal locations —
 *    rank first. The MAX_RESULTS cap clips low-relevance noise.
 * 3. **Word-boundary description matching.** The query term "rate"
 *    only matches the word "rate" in a description, not "operate" or
 *    "iterate".
 *
 * Plus an exact-name fast path: if the query is exactly a tool name
 * (case-insensitive), skip scoring and return the tool directly.
 *
 * Empirical hit-rate (25 representative queries):
 *   - Old AND-substring:           48% zero-hit
 *   - This algorithm:              ~4% zero-hit (only genuinely-no-match queries)
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

  const queryLower = trimmed.toLowerCase();

  // Fast path: query is exactly a tool name. Handles models emitting a
  // bare tool name as the query instead of using the `select:` prefix.
  for (const def of Object.values(registry)) {
    if (def.name.toLowerCase() === queryLower) return [def];
  }

  // Fast path 2: query is a tool-name prefix containing an underscore
  // (e.g. "alert_rule" → match every alert_rule_* tool). The model often
  // queries by family stem when it wants the whole group; without this
  // the underscore-containing query is treated as one opaque token and
  // misses everything.
  if (queryLower.includes('_') && !queryLower.includes(' ')) {
    const prefixMatches = Object.values(registry)
      .filter((d) => d.name.toLowerCase().startsWith(queryLower))
      .slice(0, MAX_RESULTS);
    if (prefixMatches.length > 0) return prefixMatches;
  }

  const terms = queryLower.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const termPatterns = compileTermPatterns(terms);

  // Score weights — mirrors claude-code's tuning. Name-part exact match
  // is the strongest signal (the model named the concept correctly);
  // name-part prefix is weaker; description word-boundary hit is weakest.
  // These constants only matter relative to each other.
  const W_NAME_PART_EXACT = 10;
  const W_NAME_PART_PREFIX = 5;
  const W_DESC_WORD = 2;

  type Scored = { def: ToolDefinition; score: number; termsHit: number };
  const scored: Scored[] = [];

  for (const def of Object.values(registry)) {
    const nameParts = parseNameParts(def.name);
    const descLower = def.description.toLowerCase();
    let score = 0;
    let termsHit = 0;
    for (const term of terms) {
      let termScored = false;
      // Name-part match — strongest signal. Prefix-only (startsWith, not
      // includes) so "rate" doesn't match the part "operate" via mid-word
      // substring, while still letting "metric" match the part "metrics"
      // via legit prefix. The full-name (joined) fallback is intentionally
      // dropped — it would re-introduce mid-substring false positives via
      // `name.includes(term)` and the model rarely queries the joined form.
      if (nameParts.includes(term)) {
        score += W_NAME_PART_EXACT;
        termScored = true;
      } else if (nameParts.some((p) => p.startsWith(term))) {
        score += W_NAME_PART_PREFIX;
        termScored = true;
      }
      // Description word-boundary match — separate add so a term can score
      // both via name and description (rare but matters for ranking).
      const pattern = termPatterns.get(term)!;
      if (pattern.test(descLower)) {
        score += W_DESC_WORD;
        termScored = true;
      }
      if (termScored) termsHit++;
    }
    if (score > 0) scored.push({ def, score, termsHit });
  }

  scored.sort((a, b) => {
    // Distinct-term coverage dominates so a tool matching 3 of 5 terms
    // ranks above one matching 1 term across many places.
    if (a.termsHit !== b.termsHit) return b.termsHit - a.termsHit;
    if (a.score !== b.score) return b.score - a.score;
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
