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
 * Local lint stub — returns no issues. Replace the body with a call into
 * Agent C's `dashboard_lint` core once that module lands in main:
 *
 *   import { lintDashboardSpec } from '../dashboard-lint.js';
 *   return lintDashboardSpec({ panels });
 *
 * TODO(verify-gate): wire to dashboard_lint once Agent C merges.
 */
export async function lintDashboard(_spec: {
  panels: Array<{ title: string; visualization: string; queries: Array<{ expr: string }> }>;
}): Promise<LintResult> {
  return { issues: [] };
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

  const lintSpec = {
    panels: input.panels
      .map((p) => toPreviewSpec(p))
      .filter((p): p is PanelPreviewSpec => p !== null)
      .map((p) => ({ title: p.title, visualization: p.visualization, queries: p.queries.map((q) => ({ expr: q.expr })) })),
  };
  const lint = await lintDashboard(lintSpec);

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
