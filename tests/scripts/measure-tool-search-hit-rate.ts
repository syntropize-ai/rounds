/**
 * Static hit-rate analysis for tool_search.
 *
 * No LLM calls — runs realistic natural-language queries the model is
 * likely to emit through the actual searchTools() logic (AND match,
 * whitespace tokenization, case-insensitive substring on name+desc).
 *
 * Output: per-query hit count + sample matches. Aggregates the miss rate
 * to size whether AND matching is actually the limiting factor for
 * tool_search hit rate.
 */
import { TOOL_SCHEMAS } from '../../packages/agent-core/src/agent/tool-schema-registry.js';
import { searchTools } from '../../packages/agent-core/src/agent/tool-search.js';

// Queries grouped by what the model is plausibly looking for. Mix of:
//  - exact tool-name fragments (should always hit)
//  - natural-language phrasing matching tool description style
//  - natural-language phrasing using user-vocabulary, NOT tool-vocabulary
//  - investigation-flow queries where the model knows what it wants but
//    not the exact tool name
const QUERIES: { intent: string; query: string }[] = [
  // --- Exact name fragments (sanity baseline, expect 1+) ---
  { intent: 'load metrics_query by name fragment', query: 'metrics_query' },
  { intent: 'load investigation tools by stem', query: 'investigation' },
  { intent: 'load alert tools', query: 'alert_rule' },

  // --- Natural-language, vocabulary aligned with descriptions ---
  { intent: 'query metrics', query: 'query metrics' },
  { intent: 'add panel to dashboard', query: 'add panel dashboard' },
  { intent: 'list dashboards', query: 'list dashboard' },

  // --- Natural-language, user vocabulary (latency / errors / cpu) ---
  { intent: 'check latency', query: 'check latency' },
  { intent: 'query metrics for http latency', query: 'query metrics for http latency' },
  { intent: 'investigate error rate', query: 'investigate error rate' },
  { intent: 'cpu usage query', query: 'cpu usage query' },

  // --- Investigation-flow specific (the case the user is complaining about) ---
  { intent: 'add a section to the investigation', query: 'add section investigation' },
  { intent: 'finish or complete investigation', query: 'finish investigation' },
  { intent: 'mark investigation as done', query: 'investigation done' },
  { intent: 'write narrative to investigation', query: 'write narrative investigation' },

  // --- Recent changes ---
  { intent: 'find recent deploys', query: 'recent deploys' },
  { intent: 'list recent changes', query: 'list recent changes' },
  { intent: 'changes in the last hour', query: 'changes last hour' },

  // --- Logs ---
  { intent: 'search logs', query: 'search logs' },
  { intent: 'query logs for errors', query: 'logs errors' },

  // --- Range queries ---
  { intent: 'range query over time', query: 'range query time' },
  { intent: 'time series', query: 'time series' },

  // --- Validation ---
  { intent: 'validate a promql query', query: 'validate promql' },

  // --- Web search (the second user complaint) ---
  { intent: 'web search for redis exporter metrics', query: 'web search redis exporter' },
  { intent: 'find best practices online', query: 'best practices online' },
  { intent: 'lookup vendor documentation', query: 'lookup vendor documentation' },
];

interface Row {
  intent: string;
  query: string;
  hitCount: number;
  topHits: string[];
}

function run(): Row[] {
  return QUERIES.map(({ intent, query }) => {
    const matches = searchTools(query, TOOL_SCHEMAS);
    return {
      intent,
      query,
      hitCount: matches.length,
      topHits: matches.slice(0, 3).map((m) => m.name),
    };
  });
}

function main(): void {
  const rows = run();
  console.log('=== tool_search hit-rate analysis ===\n');
  console.log('Query strategy: AND of whitespace-split terms vs name + description (case-insensitive substring).\n');

  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(w('Intent', 50) + w('Query', 45) + w('Hits', 6) + 'Top matches');
  console.log('─'.repeat(120));

  let zeros = 0;
  let lows = 0; // 1-2 hits
  for (const r of rows) {
    const top = r.topHits.length > 0 ? r.topHits.join(', ') : '(none)';
    console.log(w(r.intent, 50) + w(r.query, 45) + w(String(r.hitCount), 6) + top);
    if (r.hitCount === 0) zeros++;
    else if (r.hitCount <= 2) lows++;
  }

  console.log('\n=== Summary ===');
  console.log(`Total queries: ${rows.length}`);
  console.log(`Zero hits:     ${zeros}  (${((zeros / rows.length) * 100).toFixed(1)}%)`);
  console.log(`1-2 hits:      ${lows}  (${((lows / rows.length) * 100).toFixed(1)}%)`);
  console.log(`3+ hits:       ${rows.length - zeros - lows}  (${(((rows.length - zeros - lows) / rows.length) * 100).toFixed(1)}%)`);

  // Single-term comparison: how would each query do with OR matching?
  console.log('\n=== Counterfactual: same queries with OR matching (any term hits) ===');
  const orHits = rows.map((r) => {
    const terms = r.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matchCount = Object.values(TOOL_SCHEMAS).filter((def) => {
      const name = def.name.toLowerCase();
      const desc = def.description.toLowerCase();
      return terms.some((t) => name.includes(t) || desc.includes(t));
    }).length;
    return { intent: r.intent, query: r.query, andHits: r.hitCount, orHits: matchCount };
  });
  let orZeros = 0;
  for (const r of orHits) {
    if (r.orHits === 0) orZeros++;
    if (r.andHits === 0 && r.orHits > 0) {
      console.log(`  AND=0 → OR=${r.orHits}: "${r.query}"`);
    }
  }
  console.log(`OR strategy zero-hit rate: ${orZeros}  (${((orZeros / rows.length) * 100).toFixed(1)}%)`);
}

main();
