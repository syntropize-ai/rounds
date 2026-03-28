const WEIGHT_SYMPTOMS = 0.4;
const WEIGHT_SERVICES = 0.3;
const WEIGHT_TAGS = 0.3;
const DEFAULT_TOP_K = 3;

function tokenise(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
  );
}

function tokeniseAll(texts) {
  const result = new Set();
  for (const t of texts) {
    for (const tok of tokenise(t)) {
      result.add(tok);
    }
  }
  return result;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function jaccardStrings(a, b) {
  return jaccard(
    new Set(a.map((s) => s.toLowerCase())),
    new Set(b.map((s) => s.toLowerCase()))
  );
}

export class KeywordCaseRetriever {
  constructor(store) {
    this.store = store;
  }

  search(query) {
    const cases = this.store.list();
    if (cases.length === 0) return [];

    const topK = query.topK ?? DEFAULT_TOP_K;

    const querySymptomTokens = tokeniseAll([
      ...(query.symptoms ?? []),
      ...(query.keywords ?? []),
    ]);

    const queryServices = query.services ?? [];
    const queryTags = query.tags ?? [];

    const scored = cases.map((record) => {
      const symptomScore =
        querySymptomTokens.size > 0
          ? jaccard(querySymptomTokens, tokeniseAll(record.symptoms))
          : 0;

      const serviceScore =
        queryServices.length > 0
          ? jaccardStrings(queryServices, record.services)
          : 0;

      const tagScore =
        queryTags.length > 0
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

  static jaccardTokens(a, b) {
    return jaccard(tokenise(a), tokenise(b));
  }

  static jaccardStringArrays(a, b) {
    return jaccardStrings(a, b);
  }
}