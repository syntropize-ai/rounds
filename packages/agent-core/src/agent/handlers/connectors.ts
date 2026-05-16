import type { ActionContext } from './_context.js';
import type { SignalType, ConnectorInfo } from '../../adapters/index.js';
import type { ConnectorConfig } from '../types.js';
import { withToolEventBoundary } from './_shared.js';

// ---------------------------------------------------------------------------
// Connector discovery (always allowed — required before metrics/logs/changes)
// ---------------------------------------------------------------------------

export async function handleConnectorsList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const signalType = typeof args.signalType === 'string' ? args.signalType : undefined;
  const filter: { signalType?: SignalType } | undefined =
    signalType === 'metrics' || signalType === 'logs' || signalType === 'changes'
      ? { signalType }
      : undefined;

  return withToolEventBoundary(
    ctx.sendEvent,
    'connectors_list',
    filter ? filter : {},
    filter ? `Listing ${filter.signalType} connectors` : 'Listing connectors',
    async () => {
      const infos = ctx.adapters.list(filter);
      if (infos.length === 0) {
        return filter
          ? `No ${filter.signalType} connectors are configured.`
          : 'No connectors are configured.';
      }
      const lines = infos.map((d) => {
        const tail = d.isDefault ? ' — default' : '';
        return `id: ${d.id} (${d.type}, ${d.signalType})${tail}`;
      });
      const observation = lines.join('\n');
      return { observation, summary: `${infos.length} connector(s)` };
    },
  );
}

// ---------------------------------------------------------------------------
// Decision-pyramid helper used by suggest/pin/unpin
// ---------------------------------------------------------------------------

/** Merged connector view: AdapterRegistry info + optional environment/cluster
 *  metadata from `ctx.allConnectors` (populated by chat-service). */
interface ConnectorView {
  id: string;
  name: string;
  type: string;
  signalType?: string;
  environment?: string;
  cluster?: string;
  isDefault?: boolean;
}

function listConnectorViews(ctx: ActionContext, type?: string): ConnectorView[] {
  const cfgById = new Map<string, ConnectorConfig>();
  for (const cfg of ctx.allConnectors ?? []) cfgById.set(cfg.id, cfg);

  // Prefer the in-process AdapterRegistry as the source of truth (matches
  // handleConnectorsList) and merge in environment/cluster from allConnectors.
  const infos: ConnectorInfo[] = ctx.adapters.list();
  const views: ConnectorView[] = infos.map((info) => {
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

function buildSuggestion(views: ConnectorView[], userIntent: string): SuggestResult {
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

  // Layer 2 — default connector.
  const def = views.find((v) => v.isDefault === true);
  if (def) {
    return {
      recommendedId: def.id,
      name: def.name,
      reason: 'No explicit hint; picked the default connector.',
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

function toAlternatives(views: ConnectorView[], excludeId: string | null): SuggestResult['alternatives'] {
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
// connectors_suggest — decision pyramid (hint > default > ambiguous)
// ---------------------------------------------------------------------------

export async function handleConnectorsSuggest(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const userIntent = typeof args.userIntent === 'string' ? args.userIntent : '';
  const type = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : undefined;

  return withToolEventBoundary(
    ctx.sendEvent,
    'connectors_suggest',
    { userIntent, ...(type ? { type } : {}) },
    'Choosing connector',
    async () => {
      const views = listConnectorViews(ctx, type);
      if (views.length === 0) {
        const empty: SuggestResult = {
          recommendedId: null,
          name: null,
          reason: type
            ? `No connectors of type "${type}" are configured.`
            : 'No connectors are configured.',
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
// connectors_pin / connectors_unpin — session-scoped pinning
// ---------------------------------------------------------------------------

/** Lazy-init the per-session pins bag on first use. chat-service constructs
 *  it for each agent run; tests / fakes that omit it get an empty bag here so
 *  the pin/unpin handlers don't crash on a missing field. */
function getSessionPins(ctx: ActionContext): Record<string, string> {
  if (!ctx.sessionConnectorPins) ctx.sessionConnectorPins = {};
  return ctx.sessionConnectorPins;
}

export async function handleConnectorsPin(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  const type = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : 'prometheus';

  return withToolEventBoundary(
    ctx.sendEvent,
    'connectors_pin',
    { connectorId, type },
    'Pinning connector',
    async () => {
      if (!connectorId) return 'Error: "connectorId" is required.';
      const pins = getSessionPins(ctx);
      pins[type] = connectorId;
      return `Pinned ${type} connector to ${connectorId} for this session.`;
    },
  );
}

export async function handleConnectorsUnpin(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const type = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : 'prometheus';

  return withToolEventBoundary(
    ctx.sendEvent,
    'connectors_unpin',
    { type },
    'Unpinning connector',
    async () => {
      const pins = getSessionPins(ctx);
      if (!(type in pins)) return `No ${type} connector was pinned.`;
      delete pins[type];
      return `Unpinned ${type} connector for this session.`;
    },
  );
}
