import type { AlertRule } from '@agentic-obs/common';
import type { VerificationReport, VerificationIssue } from './types.js';

export interface AlertRuleVerifierInput {
  rule: AlertRule;
  prometheusUrl?: string;
  prometheusHeaders?: Record<string, string>;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_OPERATORS = new Set(['>', '>=', '<', '<=', '==', '!=']);

export class AlertRuleVerifier {
  async verify(input: AlertRuleVerifierInput): Promise<VerificationReport> {
    const { rule, prometheusUrl, prometheusHeaders } = input;
    const issues: VerificationIssue[] = [];
    const checksRun: string[] = [];

    // 1. name_present
    checksRun.push('name_present');
    if (!rule.name || rule.name.trim().length === 0) {
      issues.push({
        code: 'name_present',
        severity: 'error',
        message: 'Alert rule has no name',
        artifactKind: 'alert_rule',
        artifactId: rule.id,
      });
    }

    // 2. condition_present
    checksRun.push('condition_present');
    if (!rule.condition) {
      issues.push({
        code: 'condition_present',
        severity: 'error',
        message: 'Alert rule has no condition',
        artifactKind: 'alert_rule',
        artifactId: rule.id,
      });
    } else {
      if (!rule.condition.query) {
        issues.push({
          code: 'condition_present',
          severity: 'error',
          message: 'Alert rule condition is missing a query',
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      }
      if (!rule.condition.operator) {
        issues.push({
          code: 'condition_present',
          severity: 'error',
          message: 'Alert rule condition is missing an operator',
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      }
      if (rule.condition.threshold === undefined || rule.condition.threshold === null) {
        issues.push({
          code: 'condition_present',
          severity: 'error',
          message: 'Alert rule condition is missing a threshold',
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      }
    }

    // 3. query_non_empty
    checksRun.push('query_non_empty');
    if (
      rule.condition &&
      rule.condition.query !== undefined &&
      rule.condition.query.trim().length === 0
    ) {
      issues.push({
        code: 'query_non_empty',
        severity: 'error',
        message: 'Alert rule condition query is an empty string',
        artifactKind: 'alert_rule',
        artifactId: rule.id,
      });
    }

    // 4. severity_valid
    checksRun.push('severity_valid');
    if (!VALID_SEVERITIES.has(rule.severity)) {
      issues.push({
        code: 'severity_valid',
        severity: 'error',
        message: `Alert rule severity "${rule.severity}" is not valid (expected: critical, high, medium, low)`,
        artifactKind: 'alert_rule',
        artifactId: rule.id,
      });
    }

    // 5. threshold_coherent
    checksRun.push('threshold_coherent');
    if (rule.condition) {
      if (
        typeof rule.condition.threshold === 'number' &&
        !Number.isFinite(rule.condition.threshold)
      ) {
        issues.push({
          code: 'threshold_coherent',
          severity: 'error',
          message: `Alert rule threshold is not a finite number: ${rule.condition.threshold}`,
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      }
      if (rule.condition.operator && !VALID_OPERATORS.has(rule.condition.operator)) {
        issues.push({
          code: 'threshold_coherent',
          severity: 'error',
          message: `Alert rule operator "${rule.condition.operator}" is not valid (expected: >, >=, <, <=, ==, !=)`,
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      }
    }

    // 6. query_executable - test PromQL query against Prometheus (warning only)
    if (
      prometheusUrl &&
      rule.condition?.query &&
      rule.condition.query.trim().length > 0
    ) {
      checksRun.push('query_executable');
      const result = await this.testPrometheusQuery(
        prometheusUrl,
        rule.condition.query,
        prometheusHeaders,
      );
      if (result.unreachable) {
        issues.push({
          code: 'query_executable',
          severity: 'warning',
          message: `Prometheus unreachable when validating alert query: ${result.error}`,
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      } else if (!result.ok) {
        issues.push({
          code: 'query_executable',
          severity: 'warning',
          message: `Alert query "${rule.condition.query}" failed validation: ${result.error}`,
          artifactKind: 'alert_rule',
          artifactId: rule.id,
        });
      }
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
      targetKind: 'alert_rule',
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
