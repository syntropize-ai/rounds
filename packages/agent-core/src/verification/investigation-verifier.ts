import type { InvestigationReport } from '@agentic-obs/common';
import type { VerificationReport, VerificationIssue } from './types.js';

export interface InvestigationVerifierInput {
  report: InvestigationReport;
  prometheusUrl?: string;
  prometheusHeaders?: Record<string, string>;
}

export class InvestigationVerifier {
  async verify(input: InvestigationVerifierInput): Promise<VerificationReport> {
    const { report, prometheusUrl, prometheusHeaders } = input;
    const issues: VerificationIssue[] = [];
    const checksRun: string[] = [];

    // 1. summary_present
    checksRun.push('summary_present');
    if (!report.summary || report.summary.trim().length === 0) {
      issues.push({
        code: 'summary_present',
        severity: 'error',
        message: 'Investigation report has no summary',
        artifactKind: 'investigation_report',
      });
    }

    // 2. sections_exist
    checksRun.push('sections_exist');
    if (!report.sections || report.sections.length === 0) {
      issues.push({
        code: 'sections_exist',
        severity: 'error',
        message: 'Investigation report has no sections',
        artifactKind: 'investigation_report',
      });
    }

    // 3. evidence_queries_valid
    checksRun.push('evidence_queries_valid');
    const evidenceSections = (report.sections ?? []).filter(
      (s) => s.type === 'evidence' && s.panel,
    );
    for (const section of evidenceSections) {
      const panel = section.panel!;
      const queries = panel.queries ?? (panel.query ? [{ refId: 'A', expr: panel.query }] : []);
      for (const q of queries) {
        if (!q.expr || q.expr.trim().length === 0) {
          issues.push({
            code: 'evidence_queries_valid',
            severity: 'error',
            message: `Evidence panel "${panel.title}" has an empty query`,
            artifactKind: 'investigation_report',
            artifactId: panel.id,
          });
        }
      }

      // Optional Prometheus validation (warning only)
      if (prometheusUrl) {
        for (const q of queries) {
          if (!q.expr || q.expr.trim().length === 0) continue;
          const result = await this.testPrometheusQuery(
            prometheusUrl,
            q.expr,
            prometheusHeaders,
          );
          if (result.unreachable) {
            issues.push({
              code: 'evidence_queries_valid',
              severity: 'warning',
              message: `Prometheus unreachable when validating evidence panel "${panel.title}": ${result.error}`,
              artifactKind: 'investigation_report',
              artifactId: panel.id,
            });
            break; // Stop if unreachable
          } else if (!result.ok) {
            issues.push({
              code: 'evidence_queries_valid',
              severity: 'error',
              message: `Evidence query "${q.expr}" in panel "${panel.title}" failed: ${result.error}`,
              artifactKind: 'investigation_report',
              artifactId: panel.id,
            });
          }
        }
        // Stop checking further panels if Prometheus is unreachable
        if (
          issues.some(
            (i) =>
              i.code === 'evidence_queries_valid' &&
              i.message.includes('unreachable'),
          )
        ) {
          break;
        }
      }
    }

    // 4. not_all_failed - at least some evidence queries should have succeeded
    checksRun.push('not_all_failed');
    if (evidenceSections.length > 0) {
      // Check if every evidence panel has a query error issue
      const panelIdsWithErrors = new Set(
        issues
          .filter(
            (i) =>
              i.code === 'evidence_queries_valid' && i.severity === 'error',
          )
          .map((i) => i.artifactId),
      );
      const allFailed = evidenceSections.every(
        (s) => s.panel && panelIdsWithErrors.has(s.panel.id),
      );
      if (allFailed) {
        issues.push({
          code: 'not_all_failed',
          severity: 'error',
          message:
            'All evidence panels have invalid queries - investigation produced no usable evidence',
          artifactKind: 'investigation_report',
        });
      }
    }

    // 5. explanation_present - report has meaningful content even when evidence is sparse
    checksRun.push('explanation_present');
    const textSections = (report.sections ?? []).filter(
      (s) => s.content && s.content.trim().length > 0,
    );
    if (textSections.length === 0) {
      issues.push({
        code: 'explanation_present',
        severity: 'error',
        message:
          'Investigation report has no meaningful text content in any section',
        artifactKind: 'investigation_report',
      });
    }

    // Determine overall status
    const hasErrors = issues.some((i) => i.severity === 'error');
    const hasWarnings = issues.some((i) => i.severity === 'warning');
    const status = hasErrors ? 'failed' : hasWarnings ? 'warning' : 'passed';

    const summary =
      issues.length === 0
        ? `All ${checksRun.length} checks passed`
        : `${issues.filter((i) => i.severity === 'error').length} error(s), ${issues.filter((i) => i.severity === 'warning').length} warning(s) across ${checksRun.length} checks`;

    return {
      status,
      targetKind: 'investigation_report',
      summary,
      issues,
      checksRun,
    };
  }

  private async testPrometheusQuery(
    prometheusUrl: string,
    expr: string,
    headers?: Record<string, string>,
  ): Promise<{ ok: boolean; unreachable?: boolean; error?: string }> {
    try {
      const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: headers ?? {},
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          ok: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }
      const json = (await response.json()) as {
        status: string;
        error?: string;
      };
      if (json.status !== 'success') {
        return {
          ok: false,
          error: json.error ?? 'Query returned non-success status',
        };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('ECONNREFUSED') ||
        message.includes('ENOTFOUND') ||
        message.includes('ETIMEDOUT') ||
        message.includes('timeout') ||
        message.includes('fetch failed')
      ) {
        return { ok: false, unreachable: true, error: message };
      }
      return { ok: false, error: message };
    }
  }
}
