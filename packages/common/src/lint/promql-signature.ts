/**
 * PromQL query *signature* — a structural fingerprint used by the panel-event
 * pipeline to aggregate "the same query, different filter values" into one
 * bucket. The lint loop later groups deletions / edits by signature to learn
 * "this metric shape is consistently abandoned".
 *
 * Algorithm (regex-based; we intentionally do NOT depend on a full PromQL
 * parser — Agent C may land one later, in which case this can be swapped
 * behind the same `querySignature(input: string): string` interface):
 *
 *   1. Strip `# line comments` and lowercase the whole string.
 *   2. Replace any concrete `value` inside `{label="value"}` (or single-quoted,
 *      or regex `=~` / `!~`) with `*`, then sort the label entries of every
 *      selector by label name so `{a="x",b="y"}` and `{b="y",a="x"}` collapse.
 *   3. Collapse all runs of whitespace to a single space; trim.
 *
 * Two queries that differ only in (a) filter values, or (b) label-order
 * within a single selector, must map to the same signature. Differences in
 * range windows (`[5m]` vs `[1m]`), function names, or label *keys* must
 * change it.
 */

const COMMENT_RE = /#[^\n]*/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Matches a `{ ... }` selector block. Greedy `[^{}]*` is enough because
 * PromQL selectors don't nest braces.
 */
const SELECTOR_RE = /\{([^{}]*)\}/g;

/**
 * One label entry inside a selector. Captures the label name, the operator
 * (`=`, `!=`, `=~`, `!~`), and the quoted value (either `"..."` or `'...'`).
 * Escaped quotes inside the value are tolerated via the lazy quantifier; we
 * don't need to preserve the value, only blank it out.
 */
const LABEL_ENTRY_RE =
  /([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|=|!=)\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;

function normalizeSelector(inner: string): string {
  const entries: Array<{ name: string; op: string }> = [];
  let m: RegExpExecArray | null;
  // Reset state on each call — RegExp with /g is stateful.
  LABEL_ENTRY_RE.lastIndex = 0;
  while ((m = LABEL_ENTRY_RE.exec(inner)) !== null) {
    entries.push({ name: m[1]!, op: m[2]! });
  }
  if (entries.length === 0) return '';
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries.map((e) => `${e.name}${e.op}"*"`).join(',');
}

export function querySignature(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  let s = input.replace(COMMENT_RE, '');
  s = s.toLowerCase();
  s = s.replace(SELECTOR_RE, (_full, inner: string) => {
    const norm = normalizeSelector(inner);
    return `{${norm}}`;
  });
  s = s.replace(WHITESPACE_RE, ' ').trim();
  return s;
}
