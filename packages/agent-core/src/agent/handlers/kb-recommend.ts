/**
 * `kb_recommend` — given a free-text intent and (optionally) the metrics
 * actually available in the workspace, rank the top-3 KB templates/patterns
 * by a blend of TF-IDF intent match + required-metric coverage.
 *
 * Coverage gates the score: a template referencing 8 metrics, of which only
 * 1 is exposed in the workspace, drops below a less-fancy pattern that
 * doesn't pin to specific metric names. When `availableMetrics` is absent,
 * coverage defaults to 0.5 so coverage neither helps nor hurts.
 */

import { tfIdfSearch, type KnowledgeEntry } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

/** Match anything that looks like an exporter-shaped metric name. */
const METRIC_NAME_RE = /[a-z][a-z0-9_]*_(?:total|seconds|bytes|count|sum|bucket|info)\b/g;

interface Recommendation {
  id: string;
  title: string;
  kind: KnowledgeEntry['kind'];
  source: KnowledgeEntry['source'];
  score: number;
  reason: string;
}

export async function handleKbRecommend(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const intent = typeof args['intent'] === 'string' ? args['intent'].trim() : '';
  if (!intent) return 'Error: "intent" is required.';

  const availableMetrics = Array.isArray(args['availableMetrics'])
    ? (args['availableMetrics'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : undefined;
  const availableSet = availableMetrics ? new Set(availableMetrics) : undefined;

  if (!ctx.knowledge) {
    return 'Knowledge base is not configured for this workspace.';
  }
  const repo = ctx.knowledge;

  return withToolEventBoundary(
    ctx.sendEvent,
    'kb_recommend',
    { intent, hasAvailableMetrics: Boolean(availableMetrics) },
    `Recommending KB entries for "${intent.slice(0, 60)}"`,
    async () => {
      const [templates, patterns] = await Promise.all([
        repo.list(ctx.identity.orgId, { kind: 'template' }),
        repo.list(ctx.identity.orgId, { kind: 'pattern' }),
      ]);
      const all: KnowledgeEntry[] = [...templates, ...patterns];
      if (all.length === 0) {
        return 'No templates or patterns in the knowledge base.';
      }

      // Build TF-IDF corpus over title+intentTags so the intent text scores
      // against high-signal fields (vs. the entire content JSON which would
      // drown the title under boilerplate).
      const docs = all.map((e) => ({
        id: e.id,
        text: `${e.title}\n${e.intentTags.join(' ')}`,
      }));
      const tfHits = tfIdfSearch(docs, intent, all.length);
      const tfScoreById = new Map(tfHits.map((h) => [h.id, h.score]));
      const maxTf = tfHits.length > 0 ? tfHits[0]!.score : 0;

      const ranked: Recommendation[] = all.map((entry) => {
        const tfRaw = tfScoreById.get(entry.id) ?? 0;
        const tfNorm = maxTf > 0 ? tfRaw / maxTf : 0;
        const required = extractRequiredMetrics(entry);
        let coverage: number;
        let coverageDesc: string;
        if (!availableSet) {
          coverage = 0.5;
          coverageDesc = `${required.size} required metrics; availability unknown`;
        } else if (required.size === 0) {
          coverage = 0.5;
          coverageDesc = 'no specific metrics required';
        } else {
          let matched = 0;
          for (const m of required) if (availableSet.has(m)) matched++;
          coverage = matched / required.size;
          coverageDesc = `${matched}/${required.size} required metrics available`;
        }
        const score = tfNorm * 0.6 + coverage * 0.4;
        return {
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          source: entry.source,
          score: Number(score.toFixed(4)),
          reason: `Matches intent '${intent}'. ${coverageDesc}.`,
        };
      });

      ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return JSON.stringify({ entries: ranked.slice(0, 3) });
    },
  );
}

function extractRequiredMetrics(entry: KnowledgeEntry): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [entry.content];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === 'string') {
      const lower = cur.toLowerCase();
      for (const m of lower.matchAll(METRIC_NAME_RE)) {
        out.add(m[0]);
      }
    } else if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (typeof cur === 'object') {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  return out;
}
