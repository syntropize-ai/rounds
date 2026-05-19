/**
 * Server-side verify-gate around dashboard_add_panels.
 *
 * Companion safety net to the panel-authoring protocol in
 * `orchestrator-prompt.ts`. The protocol *teaches* the LLM to run
 * `panel_preview` + `dashboard_lint` before save; this gate enforces it so a
 * misbehaving (or out-of-date) agent still cannot persist a broken panel.
 *
 * Toggle via env `DASHBOARD_VERIFY_GATE`:
 *   - "1" / unset in production builds → ON (default-ON in production)
 *   - "0" → OFF; logs issues at WARN but lets the save proceed
 *
 * The "1" default is intentional for production safety. Tests should set
 * `DASHBOARD_VERIFY_GATE=0` explicitly when they want to bypass.
 */

import { createLogger } from '@agentic-obs/server-utils/logging';
import {
  LintEngine,
  BUILTIN_RULES,
  type LintContext as DashboardLintContext,
  type DashboardSpec,
  type LintIssue as RuleLintIssue,
} from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import {
  runPanelPreviewProgrammatic,
  type PanelPreviewArgs,
  type PanelPreviewSpec,
  type PanelPreviewIssue,
} from './panel-preview.js';

const log = createLogger('dashboard-verify-gate');

/**
 * Shape returned by Agent C's `dashboard_lint` once it lands. We define the
 * interface locally so this gate compiles + runs today against the stub
 * implementation below; flip the import in {@link lintDashboard} to the real
 * implementation when Agent C is merged.
 */
export interface LintIssue {
  severity: 'error' | 'warn' | 'info';
  code?: string;
  message: string;
  panelId?: string;
}

export interface LintResult {
  issues: LintIssue[];
}

/**
 * Run the real dashboard lint rules against the drafted panels.
 *
 * `LintContext` is optional per-field — rules that need a metrics backend
 * (panel-returns-data, query-uses-known-labels, high-cardinality-grouping)
 * report a single `info`-severity skip and move on when their probe is
 * missing. That degradation is intentional so the gate still runs in
 * offline test environments and pre-deployment workflows.
 */
export async function lintDashboard(
  spec: DashboardSpec,
  ctx: DashboardLintContext,
): Promise<LintResult> {
  const engine = new LintEngine();
  for (const rule of BUILTIN_RULES) engine.register(rule);
  const issues = (await engine.run(spec, ctx)) as RuleLintIssue[];
  return {
    issues: issues.map((i) => {
      const out: LintIssue = {
        severity: i.severity,
        message: i.message,
      };
      // Carry the rule name through as the issue `code` so the formatted
      // report tells operators which rule fired.
      if (i.ruleName) out.code = i.ruleName;
      if (i.panelId !== undefined) out.panelId = i.panelId;
      return out;
    }),
  };
}

export interface VerifyGateInput {
  /** Raw panel payloads from dashboard_add_panels (untyped because the
   *  handler accepts loose shapes). */
  panels: Array<Record<string, unknown>>;
  /** Optional datasource id — defaults to the resolved primary in
   *  runPanelPreviewProgrammatic. */
  datasourceId?: string;
}

export interface VerifyGateReport {
  /** True when nothing blocks the save (no preview errors, no lint errors). */
  ok: boolean;
  /** Per-panel preview issues, flattened with panel index. */
  previewIssues: Array<PanelPreviewIssue & { panelIndex: number; panelTitle: string }>;
  /** Lint issues from `dashboard_lint` (or stub). */
  lintIssues: LintIssue[];
}

/** Convert a loose panel-add payload into the typed preview spec the
 *  programmatic runner understands. */
function toPreviewSpec(p: Record<string, unknown>): PanelPreviewSpec | null {
  const title = typeof p['title'] === 'string' ? (p['title'] as string).trim() : '';
  const visualization = (p['visualization'] as PanelPreviewSpec['visualization']) ?? 'time_series';
  const queriesRaw = Array.isArray(p['queries']) ? (p['queries'] as Array<Record<string, unknown>>) : [];
  const queries = queriesRaw
    .map((q) => {
      const expr = typeof q['expr'] === 'string' ? (q['expr'] as string).trim() : '';
      if (!expr) return null;
      return {
        expr,
        legendFormat: typeof q['legendFormat'] === 'string' ? (q['legendFormat'] as string) : undefined,
        instant: q['instant'] === true,
      };
    })
    .filter((q): q is NonNullable<typeof q> => q !== null);
  if (!title || queries.length === 0) return null;
  return {
    title,
    description: typeof p['description'] === 'string' ? (p['description'] as string) : undefined,
    visualization,
    queries,
    unit: typeof p['unit'] === 'string' ? (p['unit'] as string) : undefined,
  };
}

/** Is the verify-gate enabled? Default ON; only `"0"` disables. */
export function isVerifyGateEnabled(): boolean {
  return process.env['DASHBOARD_VERIFY_GATE'] !== '0';
}

/**
 * Run preview + lint on every panel about to be saved. Returns a structured
 * report the caller (dashboard_add_panels handler) can turn into either a
 * permissive log line (gate OFF) or a hard reject observation (gate ON).
 */
export async function runDashboardVerifyGate(
  ctx: ActionContext,
  input: VerifyGateInput,
): Promise<VerifyGateReport> {
  const previewIssues: VerifyGateReport['previewIssues'] = [];

  // Degrade gracefully when no metrics datasource is configured at all —
  // a session with no backends can't be verified, and rejecting the save
  // would block legitimate offline / pre-deployment workflows. Lint still
  // runs because it's a static-spec check.
  const hasAnyMetricsConnector = (ctx.allConnectors ?? []).some(
    (c) => c.type === 'prometheus' || c.type === 'victoria-metrics',
  );

  for (let i = 0; i < input.panels.length; i++) {
    const spec = toPreviewSpec(input.panels[i]!);
    // Panels with no queries (header rows, text-only) skip preview cleanly.
    if (!spec) continue;
    if (!hasAnyMetricsConnector) continue;
    const args: PanelPreviewArgs = {
      panel: spec,
      ...(input.datasourceId ? { datasourceId: input.datasourceId } : {}),
    };
    const result = await runPanelPreviewProgrammatic(ctx, args);
    if (!result.ok) {
      for (const iss of result.issues) {
        previewIssues.push({ ...iss, panelIndex: i, panelTitle: spec.title });
      }
    }
  }

  // Build a typed DashboardSpec for the real lint engine. We synthesize the
  // fields the rules read (id, panels[].id/title/description/visualization/
  // queries) and leave the rest at neutral defaults — rules iterate only
  // what they need and ignore the rest.
  const lintDashboardSpec = buildLintDashboardSpec(input.panels);
  const lintCtx = buildLintContext(ctx, input.datasourceId);
  const lint = await lintDashboard(lintDashboardSpec, lintCtx);

  const ok =
    previewIssues.every((i) => i.severity !== 'error') &&
    lint.issues.every((i) => i.severity !== 'error');

  return { ok, previewIssues, lintIssues: lint.issues };
}

/**
 * Format a verify-gate report as a human-readable observation. Used for both
 * the rejected (gate ON) and accepted-with-warnings (gate OFF) paths.
 */
export function formatVerifyReport(report: VerifyGateReport): string {
  const lines: string[] = [];
  if (report.previewIssues.length > 0) {
    lines.push('panel_preview issues:');
    for (const iss of report.previewIssues) {
      lines.push(`  - panel[${iss.panelIndex}] "${iss.panelTitle}" [${iss.severity}] ${iss.message}` +
        (iss.fixHint ? ` (fix: ${iss.fixHint})` : ''));
    }
  }
  if (report.lintIssues.length > 0) {
    lines.push('dashboard_lint issues:');
    for (const iss of report.lintIssues) {
      const prefix = iss.panelId ? `panel ${iss.panelId} ` : '';
      lines.push(`  - ${prefix}[${iss.severity}] ${iss.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build a minimal but typed `DashboardSpec` from the loose panel payloads
 * arriving via `dashboard_add_panels`. Rules consume `panels[].id`,
 * `title`, `description`, `visualization`, `queries`, plus a handful of
 * dashboard-level fields. Everything else is filled with neutral defaults.
 */
function buildLintDashboardSpec(
  rawPanels: Array<Record<string, unknown>>,
): DashboardSpec {
  const panels = rawPanels.map((p, i) => {
    const queriesRaw = Array.isArray(p['queries'])
      ? (p['queries'] as Array<Record<string, unknown>>)
      : [];
    const queries = queriesRaw
      .filter((q) => typeof q['expr'] === 'string' && (q['expr'] as string).trim() !== '')
      .map((q) => ({
        refId: typeof q['refId'] === 'string' ? (q['refId'] as string) : 'A',
        expr: (q['expr'] as string).trim(),
        ...(typeof q['legendFormat'] === 'string' ? { legendFormat: q['legendFormat'] as string } : {}),
        ...(q['instant'] === true ? { instant: true } : {}),
        datasourceId: typeof q['datasourceId'] === 'string' ? (q['datasourceId'] as string) : '',
      }));
    return {
      id: typeof p['id'] === 'string' ? (p['id'] as string) : `draft-${i}`,
      title: typeof p['title'] === 'string' ? (p['title'] as string) : `Panel ${i + 1}`,
      description: typeof p['description'] === 'string' ? (p['description'] as string) : '',
      queries,
      visualization: (typeof p['visualization'] === 'string'
        ? (p['visualization'] as DashboardSpec['panels'][number]['visualization'])
        : 'time_series'),
      row: 0,
      col: 0,
      width: 6,
      height: 3,
      ...(typeof p['unit'] === 'string' ? { unit: p['unit'] as string } : {}),
    } as DashboardSpec['panels'][number];
  });
  return {
    id: 'draft',
    type: 'dashboard',
    title: 'Draft',
    description: '',
    prompt: '',
    userId: 'agent',
    status: 'ready',
    panels,
    variables: [],
    refreshIntervalSec: 60,
    datasourceIds: [],
    useExistingMetrics: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Construct a `LintContext` from the action context's adapter registry.
 * Returns an empty context (no probes) when no metrics adapter is
 * available; rules that need a probe will self-skip with an `info` issue.
 */
function buildLintContext(
  ctx: ActionContext,
  explicitDsId: string | undefined,
): DashboardLintContext {
  const dsId =
    explicitDsId
    ?? ctx.sessionConnectorPins?.['prometheus']
    ?? (ctx.allConnectors ?? []).find(
      (c) => c.type === 'prometheus' || c.type === 'victoria-metrics',
    )?.id;
  if (!dsId) return {};
  const adapter = ctx.adapters.metrics(dsId);
  if (!adapter) return {};
  return {
    metricsQuery: async (promql: string) => {
      const samples = await adapter.instantQuery(promql);
      return { resultLen: samples.length };
    },
    metricsLabels: async (metricName: string) => ({
      labels: await adapter.listLabels(metricName),
    }),
    metricsLabelValues: async (metricName: string, label: string) => {
      // The adapter exposes label values workspace-wide for a label, not
      // scoped to one metric. Best-effort: query the global values.
      const values = await adapter.listLabelValues(label);
      return { values };
    },
    metricsCardinality: async (metricName: string) => {
      const series = await adapter.findSeriesFull([`{__name__="${metricName}"}`]);
      return { seriesCount: series.length };
    },
  };
}

/** Emit a structured WARN log for gate-OFF accepted issues. */
export function logGateOffIssues(report: VerifyGateReport): void {
  log.warn(
    {
      previewErrors: report.previewIssues.filter((i) => i.severity === 'error').length,
      previewWarns: report.previewIssues.filter((i) => i.severity === 'warn').length,
      lintErrors: report.lintIssues.filter((i) => i.severity === 'error').length,
      lintWarns: report.lintIssues.filter((i) => i.severity === 'warn').length,
    },
    'DASHBOARD_VERIFY_GATE=0 — accepting dashboard write despite verify issues',
  );
}
