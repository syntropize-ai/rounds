/**
 * `kb_search` — keyword search over the knowledge base, ranked by TF-IDF
 * across title + intent tags + content body. Returns the top N entries with a
 * short snippet so the model can pick one and follow up with `kb_get`.
 */

import { tfIdfSearch, type KnowledgeKind } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

const VALID_KINDS: ReadonlySet<KnowledgeKind> = new Set<KnowledgeKind>([
  'pattern', 'template', 'metric_doc', 'system_fact',
]);

export async function handleKbSearch(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (!query) return 'Error: "query" is required.';

  const kindArg = typeof args['kind'] === 'string' ? args['kind'] : undefined;
  const kind = kindArg && VALID_KINDS.has(kindArg as KnowledgeKind)
    ? (kindArg as KnowledgeKind)
    : undefined;
  const limitArg = typeof args['limit'] === 'number' ? args['limit'] : 5;
  const limit = Math.max(1, Math.min(20, Math.floor(limitArg)));

  if (!ctx.knowledge) {
    return 'Knowledge base is not configured for this workspace.';
  }
  const repo = ctx.knowledge;

  return withToolEventBoundary(
    ctx.sendEvent,
    'kb_search',
    { query, kind, limit },
    `Searching knowledge base for "${query.slice(0, 60)}"`,
    async () => {
      const entries = await repo.listForSearch(
        ctx.identity.orgId,
        kind ? { kind } : {},
      );
      if (entries.length === 0) {
        return 'No knowledge base entries available.';
      }
      const docs = entries.map((e) => ({
        id: e.id,
        text: `${e.title}\n${e.intentTags.join(' ')}\n${safeStringify(e.content)}`,
      }));
      const hits = tfIdfSearch(docs, query, limit);
      if (hits.length === 0) {
        return `No KB entries matched "${query}".`;
      }
      const byId = new Map(entries.map((e) => [e.id, e]));
      const out = hits.map((h) => {
        const e = byId.get(h.id)!;
        return {
          id: e.id,
          title: e.title,
          kind: e.kind,
          source: e.source,
          score: Number(h.score.toFixed(4)),
          snippet: h.snippet,
        };
      });
      return JSON.stringify({ entries: out });
    },
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
