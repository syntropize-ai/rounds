import type { Dashboard, PanelConfig, PanelQuery } from '@agentic-obs/common';
import type { IMetricsAdapter } from '../adapters/index.js';
import type { VerificationReport, VerificationIssue } from './types.js';
import { testPrometheusQuery } from './prometheus-tester.js';

export interface DashboardVerifierInput {
  dashboard: Dashboard;
  /** @deprecated Use metricsAdapter instead */
  prometheusUrl?: string;
  /** @deprecated Use metricsAdapter instead */
  prometheusHeaders?: Record<string, string>;
  metricsAdapter?: IMetricsAdapter;
}

export class DashboardVerifier {
  async verify(input: DashboardVerifierInput): Promise<VerificationReport> {
    const { dashboard, prometheusUrl, prometheusHeaders, metricsAdapter } = input;
    const issues: VerificationIssue[] = [];
    const checksRun: string[] = [];

    // 1. title_present
    checksRun.push('title_present');
    if (!dashboard.title || dashboard.title.trim().length === 0) {
      issues.push({
        code: 'title_present',
        severity: 'error',
        message: 'Dashboard has no title',
        artifactKind: 'dashboard',
        artifactId: dashboard.id,
      });
    }

    // 2. panel_count
    checksRun.push('panel_count');
    if (!dashboard.panels || dashboard.panels.length === 0) {
      issues.push({
        code: 'panel_count',
        severity: 'error',
        message: 'Dashboard has no panels',
        artifactKind: 'dashboard',
        artifactId: dashboard.id,
      });
    }

    // 3. query_present - each panel has at least 1 query with non-empty expr
    checksRun.push('query_present');
    for (const panel of dashboard.panels ?? []) {
      const queries = this.getPanelQueries(panel);
      if (queries.length === 0) {
        issues.push({
          code: 'query_present',
          severity: 'error',
          message: `Panel "${panel.title}" (${panel.id}) has no queries`,
          artifactKind: 'dashboard',
          artifactId: panel.id,
        });
      }
    }

    // 4. variable_refs - check that $variable references have matching definitions
    checksRun.push('variable_refs');
    const definedVarNames = new Set(
      (dashboard.variables ?? []).map((v) => v.name),
    );
    for (const panel of dashboard.panels ?? []) {
      const queries = this.getPanelQueries(panel);
      for (const q of queries) {
        const refs = this.extractVariableRefs(q.expr);
        for (const ref of refs) {
          if (!definedVarNames.has(ref)) {
            issues.push({
              code: 'variable_refs',
              severity: 'warning',
              message: `Panel "${panel.title}" (${panel.id}) references undefined variable "$${ref}" in query "${q.refId}"`,
              artifactKind: 'dashboard',
              artifactId: panel.id,
            });
          }
        }
      }
    }

    // 5. duplicate_panels - detect panels with identical queries
    checksRun.push('duplicate_panels');
    const queryFingerprints = new Map<string, string>();
    for (const panel of dashboard.panels ?? []) {
      const queries = this.getPanelQueries(panel);
      const fingerprint = queries
        .map((q) => q.expr.trim())
        .sort()
        .join('|||');
      if (fingerprint && queryFingerprints.has(fingerprint)) {
        issues.push({
          code: 'duplicate_panels',
          severity: 'warning',
          message: `Panel "${panel.title}" (${panel.id}) has identical queries to panel "${queryFingerprints.get(fingerprint)}"`,
          artifactKind: 'dashboard',
          artifactId: panel.id,
        });
      } else if (fingerprint) {
        queryFingerprints.set(fingerprint, `${panel.title} (${panel.id})`);
      }
    }

    // 6. query_valid - test queries against Prometheus if adapter or URL is provided
    const queryTarget = metricsAdapter ?? prometheusUrl;
    if (queryTarget) {
      checksRun.push('query_valid');
      for (const panel of dashboard.panels ?? []) {
        const queries = this.getPanelQueries(panel);
        for (const q of queries) {
          // Skip queries containing variable references - they can't be validated without substitution
          if (this.extractVariableRefs(q.expr).length > 0) continue;

          const result = await testPrometheusQuery(
            queryTarget,
            q.expr,
            prometheusHeaders,
          );
          if (result.unreachable) {
            issues.push({
              code: 'query_valid',
              severity: 'warning',
              message: `Prometheus unreachable when validating query for panel "${panel.title}" (${panel.id}): ${result.error}`,
              artifactKind: 'dashboard',
              artifactId: panel.id,
            });
            // Stop testing further queries if Prometheus is unreachable
            break;
          } else if (!result.ok) {
            issues.push({
              code: 'query_valid',
              severity: 'warning',
              message: `Query "${q.expr}" in panel "${panel.title}" (${panel.id}) failed: ${result.error}`,
              artifactKind: 'dashboard',
              artifactId: panel.id,
            });
          }
        }
        // If Prometheus was unreachable, stop checking other panels too
        if (issues.some((i) => i.code === 'query_valid' && i.message.includes('unreachable'))) {
          break;
        }
      }
    }

    // Determine overall status
    const hasErrors = issues.some((i) => i.severity === 'error');
    const hasWarnings = issues.some((i) => i.severity === 'warning');
    const status = hasErrors ? 'failed' : hasWarnings ? 'warning' : 'passed';

    const summary = issues.length === 0
      ? `All ${checksRun.length} checks passed`
      : `${issues.filter((i) => i.severity === 'error').length} error(s), ${issues.filter((i) => i.severity === 'warning').length} warning(s) across ${checksRun.length} checks`;

    return {
      status,
      targetKind: 'dashboard',
      summary,
      issues,
      checksRun,
    };
  }

  private getPanelQueries(panel: PanelConfig): PanelQuery[] {
    if (panel.queries && panel.queries.length > 0) {
      return panel.queries.filter((q) => q.expr && q.expr.trim().length > 0);
    }
    // Backward compat: v1 single query field
    if (panel.query && panel.query.trim().length > 0) {
      return [{ refId: 'A', expr: panel.query }];
    }
    return [];
  }

  /**
   * Extract $variable references from a PromQL expression.
   * Matches patterns like $variable, ${variable}, ${variable:option}
   * Excludes Prometheus label matchers like $__rate_interval which are Grafana built-ins.
   */
  private extractVariableRefs(expr: string): string[] {
    const refs = new Set<string>();
    // Match ${varName} and ${varName:option}
    const bracketRegex = /\$\{(\w+)(?::\w+)?\}/g;
    let match: RegExpExecArray | null;
    while ((match = bracketRegex.exec(expr)) !== null) {
      const name = match[1]!;
      if (!this.isBuiltinVariable(name)) {
        refs.add(name);
      }
    }
    // Match $varName (not followed by { which was already handled)
    const plainRegex = /\$(\w+)/g;
    while ((match = plainRegex.exec(expr)) !== null) {
      const name = match[1]!;
      // Skip if this was part of a ${...} pattern
      const idx = match.index;
      if (idx > 0 && expr[idx + 1] === '{') continue;
      if (!this.isBuiltinVariable(name)) {
        refs.add(name);
      }
    }
    return Array.from(refs);
  }

  private isBuiltinVariable(name: string): boolean {
    // Grafana built-in variables start with __
    return name.startsWith('__');
  }

}
