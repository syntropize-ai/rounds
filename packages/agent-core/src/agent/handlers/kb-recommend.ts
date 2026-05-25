/**
 * `kb_recommend` — given a free-text intent, rank the top-3 KB entries by a
 * blend of hybrid intent match + required-metric coverage.
 *
 * Required metrics are extracted from the entry's markdown body by regex
 * (anything that looks like an exporter-shaped metric name). Coverage is
 * computed against the workspace's available metric names, resolved
 * SERVER-SIDE from the active metrics datasource. When no metrics
 * datasource is configured, coverage defaults to 0.5 so it neither helps
 * nor hurts the ranking.
 */

import { hybridKnowledgeSearch, type KnowledgeEntry } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

const log = createLogger('kb-recommend');

/** Match anything that looks like an exporter-shaped metric name. */
const METRIC_NAME_RE = /[a-z][a-z0-9_]*_(?:total|seconds|bytes|count|sum|bucket|info)\b/g;

interface Recommendation {
  id: string;
  title: string;
  description: string;
  source: KnowledgeEntry['source'];
  score: number;
  intentScore: number;
  lexicalScore: number;
  semanticScore: number;
  reason: string;
}

/** Resolve the metrics datasource id — session pin > primary. */
function resolveMetricsDatasourceId(ctx: ActionContext): string | undefined {
  const pin = ctx.sessionConnectorPins?.['prometheus'];
  if (pin) return pin;
  const conns = ctx.allConnectors ?? [];
  const metrics = conns.filter(
    (c) => c.type === 'prometheus' || c.type === 'victoria-metrics',
  );
  if (metrics.length === 0) return undefined;
  const primary = metrics.find((c) => c.isDefault) ?? metrics[0];
  return primary?.id;
}

/**
 * Best-effort server-side resolution of available metric names. Returns
 * `undefined` (not `[]`) when no datasource is reachable so the scoring
 * loop falls back to the "availability unknown" branch (coverage=0.5).
 */
async function resolveAvailableMetrics(
  ctx: ActionContext,
): Promise<Set<string> | undefined> {
  const dsId = resolveMetricsDatasourceId(ctx);
  if (!dsId) return undefined;
  const adapter = ctx.adapters.metrics(dsId);
  if (!adapter) return undefined;
  try {
    const names = await adapter.listMetricNames();
    return new Set(names);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), datasourceId: dsId },
      'listMetricNames probe failed; falling back to "availability unknown"',
    );
    return undefined;
  }
}

export async function handleKbRecommend(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const intent = typeof args['intent'] === 'string' ? args['intent'].trim() : '';
  if (!intent) return 'Error: "intent" is required.';

  if (!ctx.knowledge) {
    return 'Knowledge base is not configured for this workspace.';
  }
  const repo = ctx.knowledge;

  const availableSet = await resolveAvailableMetrics(ctx);

  return withToolEventBoundary(
    ctx.sendEvent,
    'kb_recommend',
    { intent, hasAvailableMetrics: Boolean(availableSet) },
    `Recommending KB entries for "${intent.slice(0, 60)}"`,
    async () => {
      const all: KnowledgeEntry[] = await repo.list(ctx.identity.orgId, {});
      if (all.length === 0) {
        return 'No knowledge base entries available.';
      }

      const intentHits = hybridKnowledgeSearch(
        all.map((e) => ({ ...e, body: '' })),
        intent,
        all.length,
      );
      const intentScoreById = new Map(intentHits.map((h) => [h.id, h]));

      const ranked: Recommendation[] = all.map((entry) => {
        const intentHit = intentScoreById.get(entry.id);
        const intentScore = intentHit?.score ?? 0;
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
        const score = intentScore * 0.6 + coverage * 0.4;
        return {
          id: entry.id,
          title: entry.title,
          description: entry.description,
          source: entry.source,
          score: Number(score.toFixed(4)),
          intentScore: Number(intentScore.toFixed(4)),
          lexicalScore: Number((intentHit?.lexicalScore ?? 0).toFixed(4)),
          semanticScore: Number((intentHit?.semanticScore ?? 0).toFixed(4)),
          reason: `Matches intent '${intent}'. ${coverageDesc}.`,
        };
      });

      ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const entries = ranked.slice(0, 3);
      if (entries.length > 0) {
        ctx.dashboardBuildEvidence.kbConsultCount += 1;
      }
      return JSON.stringify({ entries });
    },
  );
}

function extractRequiredMetrics(entry: KnowledgeEntry): Set<string> {
  const out = new Set<string>();
  const text = `${entry.title}\n${entry.description}\n${entry.body}`.toLowerCase();
  for (const m of text.matchAll(METRIC_NAME_RE)) {
    out.add(m[0]);
  }
  return out;
}
