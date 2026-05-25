import { tfIdfSearch } from './tf-idf.js';

export interface HybridKnowledgeDoc {
  id: string;
  title: string;
  description: string;
  body?: string;
  intentTags?: readonly string[];
}

export interface HybridKnowledgeHit {
  id: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  snippet: string;
}

interface WeightedDoc {
  id: string;
  lexicalText: string;
  semanticText: string;
}

const STOPLIST: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'in', 'to', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'with', 'by', 'on', 'our', 'your', 'my',
  'create', 'build', 'make', 'show', 'dashboard', 'monitor', 'monitoring',
]);

const COMPOUND_SPLITS: Readonly<Record<string, readonly string[]>> = {
  dataplane: ['data', 'plane'],
  controlplane: ['control', 'plane'],
  servicegraph: ['service', 'graph'],
};

const TOKEN_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  dataplane: ['data-plane', 'data', 'plane', 'sidecar', 'proxy', 'envoy'],
  'data-plane': ['dataplane', 'data', 'plane', 'sidecar', 'proxy', 'envoy'],
  sidecar: ['proxy', 'envoy', 'dataplane'],
  proxy: ['sidecar', 'envoy'],
  mesh: ['service-mesh', 'sidecar', 'proxy'],
  'service-mesh': ['mesh', 'sidecar', 'proxy'],
  k8s: ['kubernetes'],
  kube: ['kubernetes'],
  kubernetes: ['k8s', 'kube'],
  rps: ['reqps', 'requests', 'traffic'],
  qps: ['reqps', 'requests', 'traffic'],
  request: ['requests', 'traffic', 'rate'],
  requests: ['request', 'traffic', 'rate'],
  traffic: ['requests', 'request', 'rate'],
  latency: ['duration'],
  duration: ['latency'],
  errors: ['error', '5xx', 'failures'],
  error: ['errors', '5xx', 'failures'],
  memory: ['mem', 'bytes'],
  cpu: ['processor', 'utilization'],
};

const SNIPPET_LEN = 120;

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/^_+|_+$/g, '');
}

function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenizeForSemantics(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    const token = normalizeToken(raw);
    if (!token || STOPLIST.has(token)) continue;
    out.push(token);

    const splitParts = token.split(/[-_]+/).filter(Boolean);
    if (splitParts.length > 1) {
      out.push(...splitParts);
      out.push(splitParts.join(''));
    }

    const compound = COMPOUND_SPLITS[token];
    if (compound) out.push(...compound);
  }
  return out;
}

function addFeature(map: Map<string, number>, feature: string, weight: number): void {
  if (!feature || STOPLIST.has(feature)) return;
  map.set(feature, (map.get(feature) ?? 0) + weight);
}

function addCharNgrams(map: Map<string, number>, token: string, weight: number): void {
  const compact = token.replace(/[-_]/g, '');
  if (compact.length < 5) return;
  for (let i = 0; i <= compact.length - 3; i++) {
    addFeature(map, `#${compact.slice(i, i + 3)}`, weight);
  }
}

function vectorize(text: string, weight = 1): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokenizeForSemantics(text)) {
    addFeature(vector, token, weight);
    const stemmed = stemToken(token);
    if (stemmed !== token) addFeature(vector, stemmed, weight * 0.7);
    addCharNgrams(vector, token, weight * 0.15);
    for (const expansion of TOKEN_EXPANSIONS[token] ?? []) {
      addFeature(vector, expansion, weight * 0.55);
      addCharNgrams(vector, expansion, weight * 0.08);
    }
  }
  return vector;
}

function mergeVector(target: Map<string, number>, source: Map<string, number>): void {
  for (const [k, v] of source) target.set(k, (target.get(k) ?? 0) + v);
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const v of a.values()) aNorm += v * v;
  for (const v of b.values()) bNorm += v * v;
  if (aNorm === 0 || bNorm === 0) return 0;
  for (const [k, av] of a) dot += av * (b.get(k) ?? 0);
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function buildWeightedDoc(doc: HybridKnowledgeDoc): WeightedDoc {
  const tags = doc.intentTags?.join(' ') ?? '';
  return {
    id: doc.id,
    lexicalText: `${doc.title}\n${doc.description}\n${tags}\n${doc.body ?? ''}`,
    semanticText: [
      doc.title.repeat(3),
      tags.repeat(3),
      doc.description.repeat(2),
      doc.body ?? '',
    ].join('\n'),
  };
}

function buildSnippet(text: string, query: string): string {
  const queryTokens = tokenizeForSemantics(query);
  const lower = text.toLowerCase();
  let firstAt = -1;
  for (const token of queryTokens) {
    const at = lower.indexOf(token);
    if (at >= 0 && (firstAt === -1 || at < firstAt)) firstAt = at;
  }
  if (firstAt === -1) return text.slice(0, SNIPPET_LEN);
  const start = Math.max(0, firstAt - Math.floor(SNIPPET_LEN / 4));
  return text.slice(start, start + SNIPPET_LEN);
}

function normalizeScores(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const score of scores.values()) max = Math.max(max, score);
  if (max <= 0) return scores;
  const normalized = new Map<string, number>();
  for (const [id, score] of scores) normalized.set(id, score / max);
  return normalized;
}

export function hybridKnowledgeSearch(
  docs: readonly HybridKnowledgeDoc[],
  query: string,
  limit: number,
): HybridKnowledgeHit[] {
  if (docs.length === 0 || !query.trim()) return [];

  const weighted = docs.map(buildWeightedDoc);
  const lexicalHits = tfIdfSearch(
    weighted.map((doc) => ({ id: doc.id, text: doc.lexicalText })),
    query,
    docs.length,
  );
  const lexicalRaw = new Map(lexicalHits.map((hit) => [hit.id, hit.score]));
  const lexical = normalizeScores(lexicalRaw);

  const queryVector = vectorize(query);
  const semanticRaw = new Map<string, number>();
  for (const doc of weighted) {
    const docVector = new Map<string, number>();
    mergeVector(docVector, vectorize(doc.semanticText));
    const score = cosine(queryVector, docVector);
    if (score > 0) semanticRaw.set(doc.id, score);
  }
  const semantic = normalizeScores(semanticRaw);

  const byId = new Map(weighted.map((doc) => [doc.id, doc]));
  const ids = new Set([...lexical.keys(), ...semantic.keys()]);
  const hits: HybridKnowledgeHit[] = [];
  for (const id of ids) {
    const lexicalScore = lexical.get(id) ?? 0;
    const semanticScore = semantic.get(id) ?? 0;
    const score = lexicalScore * 0.65 + semanticScore * 0.35;
    if (score <= 0) continue;
    const doc = byId.get(id)!;
    hits.push({
      id,
      score,
      lexicalScore,
      semanticScore,
      snippet: buildSnippet(doc.lexicalText, query),
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.semanticScore !== a.semanticScore) return b.semanticScore - a.semanticScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return hits.slice(0, Math.max(0, limit));
}
