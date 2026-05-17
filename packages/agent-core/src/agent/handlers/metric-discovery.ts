/**
 * metric-discovery — six narrow read-only tools the agent uses to *discover*
 * what is in a Prometheus before drafting queries.
 *
 * Mirrors the Read/Grep/Glob philosophy from Claude Code: each tool does one
 * specific lookup. The existing `metrics_discover` collapse-tool is kept for
 * back-compat; these are the per-shape primitives the agent prefers because
 * each call's purpose is unambiguous from the tool name alone.
 *
 * All six share the same RBAC scope (`connectors:query` on the connector id)
 * and emit the same `AuditAction.MetricsQuery` audit row so the security
 * surface matches `metrics_query`.
 */

import { AuditAction } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LABEL_VALUE_LIMIT = 50;
const MAX_LABEL_VALUE_LIMIT = 500;
const DEFAULT_SAMPLE_SERIES_LIMIT = 10;
const MAX_SAMPLE_SERIES_LIMIT = 100;
const DEFAULT_FIND_RELATED_LIMIT = 10;
const MAX_FIND_RELATED_LIMIT = 50;
// Cardinality requires walking the full series set for one metric — cap the
// transport-level pull so a runaway metric (millions of series) doesn't
// freeze the loop. We surface a "truncated" signal so the model knows the
// reported count is a lower bound.
const CARDINALITY_PULL_CAP = 50_000;
// find_related needs the full series set for one metric to compute label
// overlap; same cap, same truncation signal.
const FIND_RELATED_PULL_CAP = 5_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the metrics datasource id — explicit > session pin > primary.
 * Mirrors `metric-explore.ts.resolveDatasourceId` so the discovery tools
 * inherit the same selection rules as the inline-chart bubble.
 */
function resolveDatasourceId(
  ctx: ActionContext,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
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

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInt(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), max);
}

function emitAudit(
  ctx: ActionContext,
  tool: string,
  datasourceId: string,
  outcome: 'success' | 'failure',
): void {
  if (!ctx.auditWriter) return;
  void ctx.auditWriter({
    action: AuditAction.MetricsQuery,
    actorType: 'user',
    actorId: ctx.identity.userId,
    targetType: 'connector',
    targetId: datasourceId,
    outcome,
    metadata: {
      orgId: ctx.identity.orgId,
      tool,
      source: 'agent_tool',
      sessionId: ctx.sessionId,
    },
  });
}

interface ResolvedAdapter {
  datasourceId: string;
  adapter: NonNullable<ReturnType<ActionContext['adapters']['metrics']>>;
}

/**
 * Resolve datasource + adapter. Returns either a ready-to-use bundle or an
 * observation string the caller should return verbatim. Centralizing the
 * "no datasource" / "unknown connector" branches keeps every discovery tool
 * matching `metric_explore`'s phrasing.
 */
function resolveAdapter(
  ctx: ActionContext,
  args: Record<string, unknown>,
): ResolvedAdapter | { error: string } {
  const datasourceId = resolveDatasourceId(
    ctx,
    readString(args, 'datasourceId') ?? readString(args, 'sourceId'),
  );
  if (!datasourceId) {
    return {
      error:
        'Error: no metrics datasource available. Call connectors_list to see what is configured.',
    };
  }
  const adapter = ctx.adapters.metrics(datasourceId);
  if (!adapter) {
    return { error: `Error: unknown metrics connector '${datasourceId}'.` };
  }
  return { datasourceId, adapter };
}

// ---------------------------------------------------------------------------
// metrics_list_names — { datasourceId?, match? } -> { names: string[] }
// ---------------------------------------------------------------------------

export async function handleMetricsListNames(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = resolveAdapter(ctx, args);
  if ('error' in resolved) return resolved.error;
  const { datasourceId, adapter } = resolved;
  const matchRaw = readString(args, 'match');

  return withToolEventBoundary(
    ctx.sendEvent,
    'metrics_list_names',
    { datasourceId, ...(matchRaw ? { match: matchRaw } : {}) },
    matchRaw
      ? `Listing metrics matching /${matchRaw}/`
      : 'Listing metric names',
    async () => {
      try {
        const all = await adapter.listMetricNames();
        let names = all;
        if (matchRaw) {
          let regex: RegExp;
          try {
            regex = new RegExp(matchRaw, 'i');
          } catch (err) {
            emitAudit(ctx, 'metrics_list_names', datasourceId, 'failure');
            return `metrics_list_names: invalid regex "${matchRaw}": ${err instanceof Error ? err.message : String(err)}`;
          }
          names = all.filter((n) => regex.test(n));
        }
        emitAudit(ctx, 'metrics_list_names', datasourceId, 'success');
        const truncated = names.length > MAX_LABEL_VALUE_LIMIT;
        const limited = truncated ? names.slice(0, MAX_LABEL_VALUE_LIMIT) : names;
        const body = JSON.stringify({ names: limited, truncated });
        const suffix = truncated
          ? ` (showing first ${MAX_LABEL_VALUE_LIMIT} of ${names.length}; refine \`match\`)`
          : '';
        return {
          observation: body,
          summary: `${names.length} metric name(s)${suffix}`,
        };
      } catch (err) {
        emitAudit(ctx, 'metrics_list_names', datasourceId, 'failure');
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// metrics_get_labels — { datasourceId?, metricName } -> { labels: string[] }
// ---------------------------------------------------------------------------

export async function handleMetricsGetLabels(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = resolveAdapter(ctx, args);
  if ('error' in resolved) return resolved.error;
  const { datasourceId, adapter } = resolved;
  const metricName = readString(args, 'metricName');
  if (!metricName) return 'Error: "metricName" is required.';

  return withToolEventBoundary(
    ctx.sendEvent,
    'metrics_get_labels',
    { datasourceId, metricName },
    `Listing labels for ${metricName}`,
    async () => {
      try {
        const labels = await adapter.listLabels(metricName);
        emitAudit(ctx, 'metrics_get_labels', datasourceId, 'success');
        return {
          observation: JSON.stringify({ labels }),
          summary: `${labels.length} label(s) for ${metricName}`,
        };
      } catch (err) {
        emitAudit(ctx, 'metrics_get_labels', datasourceId, 'failure');
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// metrics_get_label_values — { datasourceId?, metricName, label, limit? }
//   -> { values: string[], truncated: boolean }
// ---------------------------------------------------------------------------

export async function handleMetricsGetLabelValues(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = resolveAdapter(ctx, args);
  if ('error' in resolved) return resolved.error;
  const { datasourceId, adapter } = resolved;
  const metricName = readString(args, 'metricName');
  const label = readString(args, 'label');
  if (!metricName) return 'Error: "metricName" is required.';
  if (!label) return 'Error: "label" is required.';
  const limit = readPositiveInt(args, 'limit', DEFAULT_LABEL_VALUE_LIMIT, MAX_LABEL_VALUE_LIMIT);

  return withToolEventBoundary(
    ctx.sendEvent,
    'metrics_get_label_values',
    { datasourceId, metricName, label, limit },
    `Sampling values of ${label} on ${metricName}`,
    async () => {
      try {
        // Scope to the metric via /series so we don't dump every value of
        // (e.g.) `instance` across the whole backend.
        const series = await adapter.findSeriesFull([metricName], CARDINALITY_PULL_CAP);
        const set = new Set<string>();
        for (const s of series) {
          const v = s[label];
          if (typeof v === 'string' && v) set.add(v);
          if (set.size >= limit + 1) break;
        }
        const values = [...set];
        const truncated = values.length > limit;
        const out = truncated ? values.slice(0, limit) : values;
        emitAudit(ctx, 'metrics_get_label_values', datasourceId, 'success');
        return {
          observation: JSON.stringify({ values: out, truncated }),
          summary: `${out.length} value(s) for ${label}${truncated ? ` (truncated at ${limit})` : ''}`,
        };
      } catch (err) {
        emitAudit(ctx, 'metrics_get_label_values', datasourceId, 'failure');
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// metrics_get_cardinality — { datasourceId?, metricName } -> { seriesCount: number }
// ---------------------------------------------------------------------------

export async function handleMetricsGetCardinality(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = resolveAdapter(ctx, args);
  if ('error' in resolved) return resolved.error;
  const { datasourceId, adapter } = resolved;
  const metricName = readString(args, 'metricName');
  if (!metricName) return 'Error: "metricName" is required.';

  return withToolEventBoundary(
    ctx.sendEvent,
    'metrics_get_cardinality',
    { datasourceId, metricName },
    `Counting series for ${metricName}`,
    async () => {
      try {
        const series = await adapter.findSeriesFull([metricName], CARDINALITY_PULL_CAP);
        const seriesCount = series.length;
        const truncated = seriesCount >= CARDINALITY_PULL_CAP;
        emitAudit(ctx, 'metrics_get_cardinality', datasourceId, 'success');
        return {
          observation: JSON.stringify({ seriesCount, truncated }),
          summary: `${seriesCount}${truncated ? '+' : ''} series for ${metricName}`,
        };
      } catch (err) {
        emitAudit(ctx, 'metrics_get_cardinality', datasourceId, 'failure');
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// metrics_sample_series — { datasourceId?, metricName, limit? }
//   -> { series: Array<{ labels, value }> }
// ---------------------------------------------------------------------------

export async function handleMetricsSampleSeries(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = resolveAdapter(ctx, args);
  if ('error' in resolved) return resolved.error;
  const { datasourceId, adapter } = resolved;
  const metricName = readString(args, 'metricName');
  if (!metricName) return 'Error: "metricName" is required.';
  const limit = readPositiveInt(args, 'limit', DEFAULT_SAMPLE_SERIES_LIMIT, MAX_SAMPLE_SERIES_LIMIT);

  return withToolEventBoundary(
    ctx.sendEvent,
    'metrics_sample_series',
    { datasourceId, metricName, limit },
    `Sampling ${limit} series of ${metricName}`,
    async () => {
      try {
        const samples = await adapter.instantQuery(metricName);
        const truncated = samples.length > limit;
        const series = (truncated ? samples.slice(0, limit) : samples).map((s) => {
          const labels: Record<string, string> = {};
          for (const [k, v] of Object.entries(s.labels)) {
            if (k === '__name__') continue;
            labels[k] = v;
          }
          return { labels, value: s.value };
        });
        emitAudit(ctx, 'metrics_sample_series', datasourceId, 'success');
        return {
          observation: JSON.stringify({ series, truncated }),
          summary: `${series.length} sample series${truncated ? ` (of ${samples.length})` : ''}`,
        };
      } catch (err) {
        emitAudit(ctx, 'metrics_sample_series', datasourceId, 'failure');
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// metrics_find_related — { datasourceId?, metricName, limit? }
//   -> { related: Array<{ metric, sharedLabels }> }
// ---------------------------------------------------------------------------
//
// Strategy: find the label set of the target metric, then for each label that
// is reasonably *identifying* (job, instance, service, pod, namespace, ...
// excluding noisy ones like le/quantile), query the backend for other metric
// names whose series carry the same label key. Rank by number of shared
// labels and return the top N.
//
// We deliberately use only label KEYS, not values: matching on values would
// require N more selectors per candidate label and gives a worse "related"
// signal (two metrics sharing `instance="foo"` is much weaker evidence than
// two metrics both having an `instance` label at all on the same scrape job).

// Histogram/summary bucket dimensions and other "structural" labels carry no
// signal about which service produced the metric; skip them when scoring
// related-ness so the model doesn't fan out across every histogram in the
// backend.
const STRUCTURAL_LABELS: ReadonlySet<string> = new Set([
  '__name__', 'le', 'quantile',
]);

export async function handleMetricsFindRelated(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = resolveAdapter(ctx, args);
  if ('error' in resolved) return resolved.error;
  const { datasourceId, adapter } = resolved;
  const metricName = readString(args, 'metricName');
  if (!metricName) return 'Error: "metricName" is required.';
  const limit = readPositiveInt(args, 'limit', DEFAULT_FIND_RELATED_LIMIT, MAX_FIND_RELATED_LIMIT);

  return withToolEventBoundary(
    ctx.sendEvent,
    'metrics_find_related',
    { datasourceId, metricName, limit },
    `Finding metrics related to ${metricName}`,
    async () => {
      try {
        // Step 1: pull the target metric's series, derive its label-key set.
        const targetSeries = await adapter.findSeriesFull([metricName], FIND_RELATED_PULL_CAP);
        const targetLabels = new Set<string>();
        for (const s of targetSeries) {
          for (const k of Object.keys(s)) {
            if (STRUCTURAL_LABELS.has(k)) continue;
            targetLabels.add(k);
          }
        }
        if (targetLabels.size === 0) {
          emitAudit(ctx, 'metrics_find_related', datasourceId, 'success');
          return {
            observation: JSON.stringify({ related: [] }),
            summary: `No identifying labels on ${metricName}; nothing to relate.`,
          };
        }

        // Step 2: for each identifying label, ask the backend which other
        // metrics share that label. We use `findSeriesFull` with a selector
        // like `{label!=""}` and aggregate by __name__. Cap the per-label
        // pull to keep total work bounded.
        const shared = new Map<string, Set<string>>(); // metric -> shared label keys
        const perLabelCap = Math.max(200, Math.floor(FIND_RELATED_PULL_CAP / targetLabels.size));
        for (const label of targetLabels) {
          let candidates: Array<Record<string, string>>;
          try {
            candidates = await adapter.findSeriesFull([`{${label}!=""}`], perLabelCap);
          } catch {
            // A single selector failure shouldn't sink the whole lookup —
            // some backends reject "naked" matchers. Skip and continue.
            continue;
          }
          for (const c of candidates) {
            const name = c['__name__'];
            if (!name || name === metricName) continue;
            let set = shared.get(name);
            if (!set) {
              set = new Set<string>();
              shared.set(name, set);
            }
            set.add(label);
          }
        }

        // Step 3: rank by overlap size, break ties by name for determinism.
        const ranked = [...shared.entries()]
          .map(([metric, labels]) => ({ metric, sharedLabels: [...labels].sort() }))
          .sort((a, b) => {
            if (b.sharedLabels.length !== a.sharedLabels.length) {
              return b.sharedLabels.length - a.sharedLabels.length;
            }
            return a.metric.localeCompare(b.metric);
          });

        const related = ranked.slice(0, limit);
        const truncated = ranked.length > limit;
        emitAudit(ctx, 'metrics_find_related', datasourceId, 'success');
        return {
          observation: JSON.stringify({ related, truncated }),
          summary: `${related.length} related metric(s)${truncated ? ` (of ${ranked.length})` : ''}`,
        };
      } catch (err) {
        emitAudit(ctx, 'metrics_find_related', datasourceId, 'failure');
        throw err;
      }
    },
  );
}
