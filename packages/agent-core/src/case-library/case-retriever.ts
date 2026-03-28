// KeywordCaseRetriever - weighted Jaccard similarity retrieval
//
// Score = 0.4 x symptomJaccard + 0.3 x serviceJaccard + 0.3 x tagJaccard
//
// Weighted Jaccard: Jaccard(A, B) = |A n B| / |A u B| (sets of lowercase tokens)
//
// This is a recall aid only. The LLM must reason independently.
// Retrieved cases are injected as reference context, never as direct answers.

import type { CaseQuery, CaseRetriever, ScoredCase } from './types.js';
import type { ICaseStore } from './types.js';

const WEIGHT_SYMPTOMS = 0.4;
const WEIGHT_SERVICES = 0.3;
const WEIGHT_TAGS = 0.3;

const DEFAULT_TOP_K = 3;

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

function tokeniseAll(texts: string[]): Set<string> {
  const result = new Set<string>();
  for (const t of texts) {
    for (const tok of tokenise(t)) {
      result.add(tok);
    }
  }
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function jaccardStrings(a: string[], b: string[]): number {
  return jaccard(
    new Set(a.map((s) => s.toLowerCase())),
    new Set(b.map((s) => s.toLowerCase())),
  );
}

export class KeywordCaseRetriever implements CaseRetriever {
  private readonly store: ICaseStore;

  constructor(store: ICaseStore) {
    this.store = store;
  }

  search(query: CaseQuery): ScoredCase[] {
    const cases = this.store.list();
    if (cases.length === 0) return [];

    const topK = query.topK ?? DEFAULT_TOP_K;

    const querySymptomTokens = tokeniseAll([
      ...(query.symptoms ?? []),
      ...(query.keywords ?? []),
    ]);
    const queryServices = query.services ?? [];
    const queryTags = query.tags ?? [];

    const scored: ScoredCase[] = cases.map((record) => {
      const symptomScore = querySymptomTokens.size > 0
        ? jaccard(querySymptomTokens, tokeniseAll(record.symptoms))
        : 0;

      const serviceScore = queryServices.length > 0
        ? jaccardStrings(queryServices, record.services)
        : 0;

      const tagScore = queryTags.length > 0
        ? jaccardStrings(queryTags, record.tags)
        : 0;

      const score =
        WEIGHT_SYMPTOMS * symptomScore +
        WEIGHT_SERVICES * serviceScore +
        WEIGHT_TAGS * tagScore;

      return { record, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  static jaccardTokens(a: string, b: string): number {
    return jaccard(tokenise(a), tokenise(b));
  }

  static jaccardStringArrays(a: string[], b: string[]): number {
    return jaccardStrings(a, b);
  }
}
