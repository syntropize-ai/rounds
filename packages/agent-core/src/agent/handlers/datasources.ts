import type { ActionContext } from './_context.js';
import type { SignalType, DatasourceInfo } from '../../adapters/index.js';
import type { DatasourceConfig } from '../types.js';
import { withToolEventBoundary } from './_shared.js';

// ---------------------------------------------------------------------------
// Datasource discovery (always allowed — required before metrics/logs/changes)
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleDatasourcesList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const signalType = typeof args.signalType === 'string' ? args.signalType : undefined;
  const filter: { signalType?: SignalType } | undefined =
    signalType === 'metrics' || signalType === 'logs' || signalType === 'changes'
      ? { signalType }
      : undefined;
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'datasources_list',
    args: filter ? filter : {},
    displayText: filter ? `Listing ${filter.signalType} datasources` : 'Listing datasources',
  });

  const infos = ctx.adapters.list(filter);
  if (infos.length === 0) {
    const msg = filter
      ? `No ${filter.signalType} datasources are configured.`
      : 'No datasources are configured.';
    ctx.sendEvent({ type: 'tool_result', tool: 'datasources_list', summary: msg, success: true });
    return msg;
  }
  const lines = infos.map((d) => {
    const tail = d.isDefault ? ' — default' : '';
    return `id: ${d.id} (${d.type}, ${d.signalType})${tail}`;
  });
  const summary = lines.join('\n');
  ctx.sendEvent({
    type: 'tool_result',
    tool: 'datasources_list',
    summary: `${infos.length} datasource(s)`,
    success: true,
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Decision-pyramid helper used by suggest/pin/unpin
// ---------------------------------------------------------------------------

/** Merged datasource view: AdapterRegistry info + optional environment/cluster
 *  metadata from `ctx.allDatasources` (populated by chat-service). */
interface DatasourceView {
  id: string;
  name: string;
  type: string;
  signalType?: string;
  environment?: string;
  cluster?: string;
  isDefault?: boolean;
}

function listDatasourceViews(ctx: ActionContext, type?: string): DatasourceView[] {
  const cfgById = new Map<string, DatasourceConfig>();
  for (const cfg of ctx.allDatasources ?? []) cfgById.set(cfg.id, cfg);

  // Prefer the in-process AdapterRegistry as the source of truth (matches
  // handleDatasourcesList) and merge in environment/cluster from allDatasources.
  const infos: DatasourceInfo[] = ctx.adapters.list();
  const views: DatasourceView[] = infos.map((info) => {
    const cfg = cfgById.get(info.id);
    return {
      id: info.id,
      name: info.name,
      type: info.type,
      signalType: info.signalType,
      isDefault: info.isDefault,
      ...(cfg?.environment ? { environment: cfg.environment } : {}),
      ...(cfg?.cluster ? { cluster: cfg.cluster } : {}),
    };
  });

  if (!type) return views;
  const lower = type.toLowerCase();
  return views.filter((v) => v.type.toLowerCase() === lower);
}

interface SuggestResult {
  recommendedId: string | null;
  name: string | null;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  alternatives: Array<{ id: string; name: string; environment?: string; cluster?: string }>;
}

function buildSuggestion(views: DatasourceView[], userIntent: string): SuggestResult {
  const intent = userIntent.toLowerCase();

  // Layer 1 — explicit hint match (name / environment / cluster substring).
  if (intent) {
    const hits = views.filter((v) => {
      const name = v.name.toLowerCase();
      const env = v.environment?.toLowerCase();
      const cluster = v.cluster?.toLowerCase();
      return (
        (name && intent.includes(name)) ||
        (env && intent.includes(env)) ||
        (cluster && intent.includes(cluster))
      );
    });
    if (hits.length > 0) {
      const chosen = hits[0]!;
      const matched: string[] = [];
      if (chosen.name && intent.includes(chosen.name.toLowerCase())) matched.push(`name "${chosen.name}"`);
      if (chosen.environment && intent.includes(chosen.environment.toLowerCase())) matched.push(`environment "${chosen.environment}"`);
      if (chosen.cluster && intent.includes(chosen.cluster.toLowerCase())) matched.push(`cluster "${chosen.cluster}"`);
      return {
        recommendedId: chosen.id,
        name: chosen.name,
        reason: `User intent mentioned ${matched.join(', ') || 'a matching attribute'}.`,
        confidence: 'high',
        alternatives: toAlternatives(views, chosen.id),
      };
    }
  }

  // Layer 2 — default datasource.
  const def = views.find((v) => v.isDefault === true);
  if (def) {
    return {
      recommendedId: def.id,
      name: def.name,
      reason: 'No explicit hint; picked the default datasource.',
      confidence: 'medium',
      alternatives: toAlternatives(views, def.id),
    };
  }

  // Layer 3 — ambiguous (multiple non-default candidates, no hint).
  if (views.length > 1) {
    return {
      recommendedId: null,
      name: null,
      reason: 'AMBIGUOUS — call ask_user',
      confidence: 'low',
      alternatives: toAlternatives(views, null),
    };
  }

  // Single candidate fallback.
  const only = views[0]!;
  return {
    recommendedId: only.id,
    name: only.name,
    reason: 'no clear hint, picked first',
    confidence: 'low',
    alternatives: [],
  };
}

function toAlternatives(views: DatasourceView[], excludeId: string | null): SuggestResult['alternatives'] {
  return views
    .filter((v) => v.id !== excludeId)
    .slice(0, 5)
    .map((v) => ({
      id: v.id,
      name: v.name,
      ...(v.environment ? { environment: v.environment } : {}),
      ...(v.cluster ? { cluster: v.cluster } : {}),
    }));
}

// ---------------------------------------------------------------------------
// datasources_suggest — decision pyramid (hint > default > ambiguous)
// ---------------------------------------------------------------------------

export async function handleDatasourcesSuggest(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const userIntent = typeof args.userIntent === 'string' ? args.userIntent : '';
  const type = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : undefined;

  return withToolEventBoundary(
    ctx.sendEvent,
    'datasources_suggest',
    { userIntent, ...(type ? { type } : {}) },
    'Choosing data source',
    async () => {
      const views = listDatasourceViews(ctx, type);
      if (views.length === 0) {
        const empty: SuggestResult = {
          recommendedId: null,
          name: null,
          reason: type
            ? `No datasources of type "${type}" are configured.`
            : 'No datasources are configured.',
          confidence: 'low',
          alternatives: [],
        };
        return { observation: JSON.stringify(empty), summary: empty.reason };
      }
      const result = buildSuggestion(views, userIntent);
      const summary = result.recommendedId
        ? `Suggested ${result.name} (${result.confidence})`
        : 'Ambiguous — needs user input';
      // Surface a `ds_choice` event so the chat UI can render an inline
      // chip ("Using prod-prom · switch ▼") next to the agent's narration.
      // Skipped on the AMBIGUOUS branch — the agent will follow up with
      // ask_user, which already has its own button-group affordance.
      if (result.recommendedId && result.name) {
        ctx.sendEvent({
          type: 'ds_choice',
          chosenId: result.recommendedId,
          name: result.name,
          reason: result.reason,
          confidence: result.confidence,
          alternatives: result.alternatives,
        });
      }
      return { observation: JSON.stringify(result), summary };
    },
  );
}

// ---------------------------------------------------------------------------
// datasources_pin / datasources_unpin — session-scoped pinning
// ---------------------------------------------------------------------------

/** Lazy-init the per-session pins bag on first use. chat-service constructs
 *  it for each agent run; tests / fakes that omit it get an empty bag here so
 *  the pin/unpin handlers don't crash on a missing field. */
function getSessionPins(ctx: ActionContext): Record<string, string> {
  if (!ctx.sessionDatasourcePins) ctx.sessionDatasourcePins = {};
  return ctx.sessionDatasourcePins;
}

export async function handleDatasourcesPin(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const datasourceId = typeof args.datasourceId === 'string' ? args.datasourceId.trim() : '';
  const type = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : 'prometheus';

  return withToolEventBoundary(
    ctx.sendEvent,
    'datasources_pin',
    { datasourceId, type },
    'Pinning data source',
    async () => {
      if (!datasourceId) return 'Error: "datasourceId" is required.';
      const pins = getSessionPins(ctx);
      pins[type] = datasourceId;
      return `Pinned ${type} datasource to ${datasourceId} for this session.`;
    },
  );
}

export async function handleDatasourcesUnpin(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const type = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : 'prometheus';

  return withToolEventBoundary(
    ctx.sendEvent,
    'datasources_unpin',
    { type },
    'Unpinning data source',
    async () => {
      const pins = getSessionPins(ctx);
      if (!(type in pins)) return `No ${type} datasource was pinned.`;
      delete pins[type];
      return `Unpinned ${type} datasource for this session.`;
    },
  );
}
