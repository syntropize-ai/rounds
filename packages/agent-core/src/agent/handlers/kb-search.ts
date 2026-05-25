/**
 * `kb_search` — hybrid search over the unified knowledge base, ranked by
 * lexical TF-IDF plus local semantic features across title + description +
 * body + intentTags. Returns the top N entries with a short snippet so the
 * model can pick one and follow up with `kb_get`.
 */

import { hybridKnowledgeSearch } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

export async function handleKbSearch(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (!query) return 'Error: "query" is required.';

  const limitArg = typeof args['limit'] === 'number' ? args['limit'] : 5;
  const limit = Math.max(1, Math.min(20, Math.floor(limitArg)));

  if (!ctx.knowledge) {
    return 'Knowledge base is not configured for this workspace.';
  }
  const repo = ctx.knowledge;

  return withToolEventBoundary(
    ctx.sendEvent,
    'kb_search',
    { query, limit },
    `Searching knowledge base for "${query.slice(0, 60)}"`,
    async () => {
      const entries = await repo.listForSearch(ctx.identity.orgId, {});
      if (entries.length === 0) {
        return 'No knowledge base entries available.';
      }
      const hits = hybridKnowledgeSearch(entries, query, limit);
      if (hits.length === 0) {
        return `No KB entries matched "${query}".`;
      }
      ctx.dashboardBuildEvidence.kbConsultCount += 1;
      const byId = new Map(entries.map((e) => [e.id, e]));
      const out = hits.map((h) => {
        const e = byId.get(h.id)!;
        return {
          id: e.id,
          title: e.title,
          description: e.description,
          source: e.source,
          score: Number(h.score.toFixed(4)),
          lexicalScore: Number(h.lexicalScore.toFixed(4)),
          semanticScore: Number(h.semanticScore.toFixed(4)),
          snippet: h.snippet,
        };
      });
      return JSON.stringify({ entries: out });
    },
  );
}
