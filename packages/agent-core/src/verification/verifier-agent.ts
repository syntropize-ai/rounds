import type { Dashboard, InvestigationReport, AlertRule } from '@agentic-obs/common';
import type { VerificationTargetKind, VerificationReport, VerificationContext } from './types.js';
import { DashboardVerifier } from './dashboard-verifier.js';
import { InvestigationVerifier } from './investigation-verifier.js';
import { AlertRuleVerifier } from './alert-rule-verifier.js';

export class VerifierAgent {
  private readonly dashboardVerifier = new DashboardVerifier();
  private readonly investigationVerifier = new InvestigationVerifier();
  private readonly alertRuleVerifier = new AlertRuleVerifier();

  async verify(
    targetKind: VerificationTargetKind,
    target: unknown,
    context?: VerificationContext,
  ): Promise<VerificationReport> {
    switch (targetKind) {
      case 'dashboard': {
        return this.dashboardVerifier.verify({
          dashboard: target as Dashboard,
          prometheusUrl: context?.prometheusUrl,
          prometheusHeaders: context?.prometheusHeaders,
        });
      }

      case 'investigation_report': {
        return this.investigationVerifier.verify({
          report: target as InvestigationReport,
          prometheusUrl: context?.prometheusUrl,
          prometheusHeaders: context?.prometheusHeaders,
        });
      }

      case 'alert_rule': {
        return this.alertRuleVerifier.verify({
          rule: target as AlertRule,
          prometheusUrl: context?.prometheusUrl,
          prometheusHeaders: context?.prometheusHeaders,
        });
      }

      default: {
        // Fail-closed: unknown target kinds are rejected, not silently passed
        return {
          status: 'failed',
          targetKind,
          summary: `Unknown verification target kind "${targetKind}" — blocked (fail-closed)`,
          issues: [{
            code: 'unknown_target_kind',
            severity: 'error',
            message: `Verification target kind "${targetKind}" is not recognized. This may indicate a misconfiguration or missing verifier implementation.`,
            artifactKind: targetKind,
          }],
          checksRun: ['target_kind_check'],
        };
      }
    }
  }
}
