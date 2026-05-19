/**
 * Tiny TF-IDF ranker for the knowledge base. Pure in-memory — KB corpora are
 * O(100) entries so a per-call full re-rank is cheap and keeps callers
 * dependency-free.
 *
 * Conventions:
 *   - Tokens are `[a-z0-9_-]+` after lowercasing; everything else is a
 *     separator.
 *   - A small English stoplist is dropped so high-frequency function words
 *     don't dominate.
 *   - IDF uses `log(1 + N/df)` — bounded above zero so single-doc corpora
 *     still produce a positive score (vs. classic `log(N/df)` which collapses
 *     to zero when df=N).
 *   - Snippets center on the first matching token, expanded to 120 chars.
 */

const STOPLIST: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'in', 'to', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'being',
]);

const SNIPPET_LEN = 120;

export interface TfIdfDoc {
  id: string;
  text: string;
}

export interface TfIdfHit {
  id: string;
  score: number;
  snippet: string;
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (!raw) continue;
    if (STOPLIST.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function buildSnippet(rawText: string, queryTokens: ReadonlySet<string>): string {
  if (!rawText) return '';
  // Walk lowercased text scanning for first matching token boundary.
  const lower = rawText.toLowerCase();
  let firstAt = -1;
  for (const token of queryTokens) {
    // Whole-token match using a non-alphanumeric boundary on either side.
    const re = new RegExp(`(?:^|[^a-z0-9_-])${escapeRegex(token)}(?:$|[^a-z0-9_-])`);
    const m = re.exec(lower);
    if (m && (firstAt === -1 || m.index < firstAt)) {
      // index points at the leading boundary char (unless start-of-string);
      // shift forward so the snippet starts on the token itself.
      firstAt = m.index === 0 ? 0 : m.index + 1;
    }
  }
  if (firstAt === -1) {
    return rawText.slice(0, SNIPPET_LEN);
  }
  const start = Math.max(0, firstAt - Math.floor(SNIPPET_LEN / 4));
  return rawText.slice(start, start + SNIPPET_LEN);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tfIdfSearch(
  docs: readonly TfIdfDoc[],
  query: string,
  limit: number,
): TfIdfHit[] {
  if (docs.length === 0) return [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const qSet = new Set(qTokens);

  // Per-doc tokenized form + token counts.
  const docTokens: string[][] = docs.map((d) => tokenize(d.text));
  const docTokenCounts: Map<string, number>[] = docTokens.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });

  // DF per query token.
  const N = docs.length;
  const df = new Map<string, number>();
  for (const qt of qSet) {
    let count = 0;
    for (const m of docTokenCounts) {
      if (m.has(qt)) count++;
    }
    df.set(qt, count);
  }

  const scored: TfIdfHit[] = [];
  for (let i = 0; i < docs.length; i++) {
    const tokens = docTokens[i]!;
    const counts = docTokenCounts[i]!;
    const total = tokens.length;
    if (total === 0) continue;

    let score = 0;
    let matched = false;
    for (const qt of qTokens) {
      const c = counts.get(qt) ?? 0;
      if (c === 0) continue;
      matched = true;
      const tf = c / total;
      const idf = Math.log(1 + N / Math.max(1, df.get(qt) ?? 0));
      score += tf * idf;
    }
    if (!matched) continue;

    scored.push({
      id: docs[i]!.id,
      score,
      snippet: buildSnippet(docs[i]!.text, qSet),
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return scored.slice(0, Math.max(0, limit));
}
