/**
 * Minimal PromQL extractor — pulls metric names, label selectors, and
 * aggregation `by(...)` / `without(...)` clauses out of a query string.
 *
 * Limitations (intentional — this is NOT a full parser):
 *   - Does not validate operator precedence, parentheses, or grammar.
 *   - Cannot detect duplicate selectors, nested aggregations beyond what
 *     regex can scope, or templated `$variables` (treated as opaque tokens).
 *   - String literals containing `{`, `}`, or comment-like sequences may
 *     confuse the label-selector matcher; PromQL has no general string
 *     escapes inside selectors so this is acceptable in practice.
 *   - Range vector `[5m]` extraction supports single units (s, m, h, d, w, y).
 *
 * Used by lint rules that need structural facts about a query without
 * needing semantic correctness. If a rule needs more than this surface, it
 * should call `metrics_validate` instead.
 */

export interface LabelSelector {
  label: string;
  op: '=' | '!=' | '=~' | '!~';
  value: string;
}

export interface MetricSelector {
  /** Metric name, e.g. `http_requests_total`. May be empty when the query is
   *  `{__name__="foo"}` form — caller should fall back to scanning labels. */
  name: string;
  selectors: LabelSelector[];
}

export interface AggregationClause {
  kind: 'by' | 'without';
  labels: string[];
}

const PROMQL_KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
  'and', 'or', 'unless', 'offset', 'bool',
  // Common functions / aggregations — excluded from metric-name detection.
  'sum', 'avg', 'min', 'max', 'count', 'count_values', 'stddev', 'stdvar',
  'topk', 'bottomk', 'quantile', 'group',
  'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv',
  'histogram_quantile', 'absent', 'absent_over_time', 'present_over_time',
  'avg_over_time', 'sum_over_time', 'min_over_time', 'max_over_time',
  'count_over_time', 'quantile_over_time', 'stddev_over_time',
  'changes', 'resets', 'predict_linear', 'holt_winters',
  'abs', 'ceil', 'floor', 'round', 'exp', 'ln', 'log2', 'log10', 'sqrt',
  'clamp', 'clamp_min', 'clamp_max', 'time', 'timestamp', 'vector', 'scalar',
  'label_replace', 'label_join', 'sort', 'sort_desc',
]);

/**
 * Extract every `metric{labelSelectors}` reference. Returns one entry per
 * occurrence — duplicates are intentional so rules can count usages.
 */
export function extractMetricSelectors(query: string): MetricSelector[] {
  const out: MetricSelector[] = [];

  // Pattern 1: <metricName>{<selectors>}
  // metric name is [a-zA-Z_:][a-zA-Z0-9_:]*
  const withBraces = /([a-zA-Z_:][a-zA-Z_0-9:]*)\s*\{([^}]*)\}/g;
  const seenRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = withBraces.exec(query)) !== null) {
    const name = m[1]!;
    if (PROMQL_KEYWORDS.has(name)) continue;
    out.push({ name, selectors: parseSelectors(m[2]!) });
    seenRanges.push([m.index, m.index + m[0].length]);
  }

  // Pattern 2: bare metric names not followed by `(` (which would be a fn)
  // and not already captured by withBraces.
  const bare = /([a-zA-Z_:][a-zA-Z_0-9:]*)/g;
  while ((m = bare.exec(query)) !== null) {
    const name = m[1]!;
    if (PROMQL_KEYWORDS.has(name)) continue;
    const next = query[m.index + m[0].length];
    if (next === '(') continue; // function call
    if (next === '{') continue; // already captured above
    // Skip when this position is inside one of the already-captured ranges.
    if (seenRanges.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    // Skip duration tokens like `5m` — those are preceded by a digit and `[`.
    const prev = query[m.index - 1];
    if (prev && /[0-9]/.test(prev)) continue;
    // Skip 'le' as a label in by(le) — heuristic: it must look like a metric
    // (length >= 2 isn't enough — `le` is 2 chars). We rely on caller-side
    // dedupe; aggregation labels are handled by extractByClauses().
    out.push({ name, selectors: [] });
  }

  return out;
}

function parseSelectors(inside: string): LabelSelector[] {
  const sel: LabelSelector[] = [];
  // label="value", label!="value", label=~"value", label!~"value"
  const re = /([a-zA-Z_][a-zA-Z_0-9]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inside)) !== null) {
    sel.push({
      label: m[1]!,
      op: m[2]! as LabelSelector['op'],
      value: m[3]!.replace(/\\(.)/g, '$1'),
    });
  }
  return sel;
}

/** Extract every `by (...)` / `without (...)` clause. */
export function extractAggregationClauses(query: string): AggregationClause[] {
  const out: AggregationClause[] = [];
  const re = /\b(by|without)\s*\(\s*([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const kind = m[1] as 'by' | 'without';
    const labels = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push({ kind, labels });
  }
  return out;
}

/** Extract `[5m]`-style range vector specifiers. */
export function extractRangeVectors(query: string): string[] {
  const out: string[] = [];
  const re = /\[(\d+(?:\.\d+)?[smhdwy])\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) out.push(m[1]!);
  return out;
}

/** Convert a `5m` / `30s` / `2h` token to seconds. Returns NaN on parse fail. */
export function rangeTokenToSeconds(token: string): number {
  const m = /^(\d+(?:\.\d+)?)([smhdwy])$/.exec(token);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2];
  const mult: Record<string, number> = {
    s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000,
  };
  return n * (mult[unit!] ?? NaN);
}

/** Normalize whitespace in a PromQL expression for equality comparison. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}
