/**
 * `dashboard_lint` — run the BUILTIN_RULES against a DashboardSpec and
 * return an aggregated issue list.
 *
 * Wiring philosophy: the lint engine lives in @agentic-obs/common and is
 * pure — it has no awareness of connectors, adapters, or RBAC. This handler
 * is the bridge: it picks the primary metrics adapter and exposes only the
 * four small read-side hooks `LintContext` exposes
 * (`metricsQuery` / `metricsLabels` / `metricsLabelValues` / `metricsCardinality`).
 *
 * If no metrics adapter is configured, the context is built with those
 * hooks undefined — rules that need them emit a single `info` "rule
 * skipped" issue instead of throwing. The dashboard_lint call still
 * succeeds and returns whatever the pure rules produce.
 */

import {
  BUILTIN_RULES,
  LintEngine,
  type DashboardSpec,
  type LintContext,
  type LintIssue,
} from '@agentic-obs/common';
import type { ActionContext } from './_context.js';

/**
 * Resolve the metrics datasource id — explicit arg > session pin > the
 * primary (`isDefault`) metrics connector. Matches `metric_explore`'s
 * resolution so a session that has been narrating against one connector
 * lints against the same one.
 */
function resolveMetricsDatasourceId(ctx: ActionContext, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const pin = ctx.sessionConnectorPins?.['prometheus'];
  if (pin) return pin;
  const conns = ctx.allConnectors ?? [];
  const metrics = conns.filter(
    (c) => c.type === 'prometheus' || c.type === 'victoria-metrics',
  );
  if (metrics.length === 0) return undefined;
  return (metrics.find((c) => c.isDefault) ?? metrics[0])?.id;
}

/**
 * Cheap shape validation. The handler accepts the spec as a raw object
 * (the agent constructs JSON) — we sanity-check the bits the rules touch
 * so they don't throw deep in the run loop.
 */
function validateSpec(raw: unknown): { ok: true; spec: DashboardSpec } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'spec must be an object' };
  const obj = raw as Partial<DashboardSpec>;
  if (!Array.isArray(obj.panels)) return { ok: false, reason: 'spec.panels must be an array' };
  for (const panel of obj.panels) {
    if (!panel || typeof panel !== 'object') {
      return { ok: false, reason: 'every panel must be an object' };
    }
    if (typeof (panel as { id?: unknown }).id !== 'string') {
      return { ok: false, reason: 'every panel must have a string id' };
    }
  }
  return { ok: true, spec: raw as DashboardSpec };
}

/**
 * Build the lint context. Each hook adapts the source-agnostic
 * `IMetricsAdapter` surface to the rule-friendly shape (`{ resultLen }`,
 * `{ labels }`, ...). Failures are translated to thrown errors — the
 * engine catches them and degrades the rule to an info-severity issue.
 */
function buildLintContext(ctx: ActionContext, datasourceId: string | undefined): LintContext {
  if (!datasourceId) return {};
  const adapter = ctx.adapters.metrics(datasourceId);
  if (!adapter) return {};
  return {
    metricsQuery: async (promql) => {
      const samples = await adapter.instantQuery(promql);
      return { resultLen: samples.length };
    },
    metricsLabels: async (metricName) => {
      const labels = await adapter.listLabels(metricName);
      return { labels };
    },
    metricsLabelValues: async (_metricName, label) => {
      // Backend label-value endpoints are global per label name — they don't
      // accept a metric filter. Returning the raw set is consistent with how
      // `metrics_discover kind=values` reports them, and rule 2 already
      // skips value-validation when the set exceeds 50 entries.
      const values = await adapter.listLabelValues(label);
      return { values };
    },
    metricsCardinality: async (metricName) => {
      const series = await adapter.findSeries([`{__name__="${metricName}"}`]);
      return { seriesCount: series.length };
    },
  };
}

export async function handleDashboardLint(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const validation = validateSpec(args['spec']);
  if (!validation.ok) {
    const err = `Error: ${validation.reason}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_lint', summary: err, success: false });
    return err;
  }
  const spec = validation.spec;

  const datasourceId = resolveMetricsDatasourceId(
    ctx,
    typeof args['datasourceId'] === 'string' ? args['datasourceId'] : undefined,
  );
  const lintCtx = buildLintContext(ctx, datasourceId);

  const only = Array.isArray(args['only']) ? (args['only'] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
  const skip = Array.isArray(args['skip']) ? (args['skip'] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;

  const engine = new LintEngine();
  for (const rule of BUILTIN_RULES) engine.register(rule);

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'dashboard_lint',
    args: { panelCount: spec.panels.length, ruleCount: BUILTIN_RULES.length },
    displayText: `Linting dashboard (${spec.panels.length} panel${spec.panels.length === 1 ? '' : 's'})…`,
  });

  const issues: LintIssue[] = await engine.run(spec, lintCtx, { only, skip });

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.filter((i) => i.severity === 'warn').length;
  const infos = issues.filter((i) => i.severity === 'info').length;
  const summary = `Lint complete: ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}, ${infos} info.`;

  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_lint', summary, success: true });

  if (issues.length === 0) {
    return `${summary} No issues found.`;
  }
  // Return the issue list inline so the agent can react. Cap message length
  // per issue to keep the observation compact.
  const lines = issues.map((i) => {
    const scope = i.panelId ? `[${i.severity}/${i.ruleName} on ${i.panelId}]` : `[${i.severity}/${i.ruleName}]`;
    const hint = i.fixHint ? ` — fix: ${i.fixHint}` : '';
    return `${scope} ${i.message}${hint}`;
  });
  return `${summary}\n${lines.join('\n')}`;
}
