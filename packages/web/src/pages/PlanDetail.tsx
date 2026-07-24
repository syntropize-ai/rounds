/**
 * /plans/:id — review + approve a single RemediationPlan.
 *
 * P7 of `docs/design/auto-remediation.md`. Shows the plan summary, source
 * investigation, ordered step list with dry-run previews + risk notes,
 * and an approve form. Failed plans get a "retry this step" affordance.
 * Plans with a rescue plan get a "Run rescue plan" link.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiClient, plansApi } from '../api/client.js';
import type {
  RemediationPlan,
  RemediationPlanStep,
  RemediationPlanStatus,
  RemediationPlanStepStatus,
  RemediationPlanVerificationStatus,
} from '../api/client.js';
import type { ApiResponse } from '../api/types.js';
import type { Provenance } from '@agentic-obs/common';
import { useAuth } from '../contexts/AuthContext.js';
import { relativeTime, expiryLabel } from '../utils/time.js';
import StatusPill from '../components/StatusPill.js';

interface AlertRuleLite {
  id: string;
  name: string;
  state: string;
  severity: string;
  investigationId?: string;
  labels?: Record<string, string>;
}

interface AlertRulesResponse {
  list?: AlertRuleLite[];
}

interface InvestigationLite {
  id: string;
  intent: string;
  status: string;
}

interface InvestigationReportLite {
  summary: string;
  provenance?: Provenance;
}

function humanizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandVerb(step: RemediationPlanStep): string {
  const text = step.commandText.trim();
  const parts = text.split(/\s+/);
  const kubectlIndex = parts.findIndex((p) => p === 'kubectl');
  if (kubectlIndex >= 0 && parts[kubectlIndex + 1]) return parts[kubectlIndex + 1]!;
  return parts[0] ?? 'run';
}

function commandTarget(step: RemediationPlanStep): string {
  const text = step.commandText;
  const match = text.match(/\b(virtualservice|serviceentry|deployment|deploy|pod|service|svc|configmap|secret)\s+([^\s]+)/i);
  if (match) return `${match[1]} ${match[2]}`;
  return step.kind.replace(/\./g, ' ');
}

function stepTitle(step: RemediationPlanStep): string {
  const verb = humanizeName(commandVerb(step));
  const target = commandTarget(step);
  return `${verb} ${target}`;
}

function shortCommand(command: string): string {
  return command.replace(/^kubectl\s+/, '').replace(/\s+/g, ' ').trim();
}

function rootCauseText(report: InvestigationReportLite | null): string {
  const gate = report?.provenance?.rootCauseGate;
  if (!gate?.rootCause) return 'No verified root cause recorded';
  const bits = [
    gate.rootCause.object,
    gate.rootCause.field,
    gate.rootCause.cause,
  ].filter((v): v is string => Boolean(v && v.trim()));
  return bits.length > 0 ? bits.join(' · ') : 'Root cause verified';
}

function confidenceLabel(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'unknown';
  return `${Math.round(value * 100)}%`;
}

function planRisk(plan: RemediationPlan): 'medium' | 'high' | 'critical' {
  const commands = plan.steps.map((s) => s.commandText.toLowerCase()).join('\n');
  if (/\b(delete|drain|cordon|uncordon)\b/.test(commands)) return 'critical';
  if (/\b(apply|patch|replace|rollout|restart|scale)\b/.test(commands)) return 'high';
  return 'medium';
}

const RISK_STYLE = {
  medium: 'bg-[#F59E0B]/10 text-[#B45309]',
  high: 'bg-[#F97316]/10 text-[#C2410C]',
  critical: 'bg-[#EF4444]/10 text-[#DC2626]',
} as const;

// Map remediation plan/step statuses to a StatusPill (kind, value).
// Statuses without a semantic colour (draft/expired/cancelled/skipped)
// render as a neutral surface chip.
type Tone =
  | { kind: 'severity'; value: 'critical' | 'info' }
  | { kind: 'state'; value: 'firing' | 'pending' | 'resolved' }
  | null;

const STATUS_TONE: Record<string, Tone> = {
  draft: null,
  pending_approval: { kind: 'state', value: 'pending' },
  approved: { kind: 'severity', value: 'info' },
  executing: { kind: 'severity', value: 'info' },
  applied: { kind: 'severity', value: 'info' },
  execution_failed: { kind: 'state', value: 'firing' },
  completed: { kind: 'state', value: 'resolved' },
  failed: { kind: 'state', value: 'firing' },
  rejected: { kind: 'state', value: 'firing' },
  expired: null,
  cancelled: null,
  pending: { kind: 'state', value: 'pending' },
  done: { kind: 'state', value: 'resolved' },
  skipped: null,
};

function StatusBadge({ status }: { status: RemediationPlanStatus | RemediationPlanStepStatus }) {
  const tone = STATUS_TONE[status] ?? null;
  const label = String(status).replace(/_/g, ' ');
  if (tone === null) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide bg-[var(--color-surface-high)] text-[var(--color-outline)]">
        {label}
      </span>
    );
  }
  return <StatusPill kind={tone.kind} value={tone.value} label={label} size="md" />;
}

function verificationTone(status: RemediationPlanVerificationStatus): Tone {
  if (status === 'passed') return { kind: 'state', value: 'resolved' };
  if (status === 'failed') return { kind: 'state', value: 'firing' };
  if (status === 'waiting') return { kind: 'state', value: 'pending' };
  if (status === 'inconclusive') return { kind: 'severity', value: 'info' };
  return null;
}

function VerificationBadge({ status }: { status: RemediationPlanVerificationStatus }) {
  const tone = verificationTone(status);
  const label = status === 'passed'
    ? 'fixed'
    : status === 'failed'
      ? 'ineffective'
      : status.replace(/_/g, ' ');
  if (tone === null) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide bg-[var(--color-surface-high)] text-[var(--color-outline)]">
        {label}
      </span>
    );
  }
  return <StatusPill kind={tone.kind} value={tone.value} label={label} size="md" />;
}

function outcomeTitle(plan: RemediationPlan): string {
  if (plan.status === 'pending_approval') return 'Approve this plan to run it now';
  if (plan.status === 'executing' || plan.status === 'approved') return 'Running approved changes';
  if (plan.status === 'execution_failed' || plan.status === 'failed') return 'Execution failed';
  if (plan.status === 'applied' || plan.status === 'completed') {
    if (plan.verificationStatus === 'passed') return 'Change applied and verified';
    if (plan.verificationStatus === 'failed') return 'Change applied but did not fix the alert';
    if (plan.verificationStatus === 'waiting') return 'Change applied, verifying impact';
    if (plan.verificationStatus === 'inconclusive') return 'Change applied, verification inconclusive';
    return 'Change applied';
  }
  return 'Plan execution state';
}

function outcomeDescription(plan: RemediationPlan): string {
  if (plan.status === 'pending_approval') {
    return `This will run ${plan.steps.length} ordered step${plan.steps.length === 1 ? '' : 's'} once. It does not change future approval policy.`;
  }
  if (plan.status === 'execution_failed' || plan.status === 'failed') {
    return 'At least one command failed. The alert may still be firing because the change was not fully applied.';
  }
  if (plan.verificationStatus === 'passed') {
    return 'The linked alert recovered after the change was applied.';
  }
  if (plan.verificationStatus === 'failed') {
    return 'The commands ran successfully, but the linked alert was still firing after the validation window.';
  }
  if (plan.verificationStatus === 'waiting') {
    return 'The commands ran successfully. Rounds is waiting for fresh alert evaluations before calling this fixed.';
  }
  if (plan.verificationStatus === 'inconclusive') {
    return 'Rounds could not prove whether the change fixed the alert. Review the validation evidence before taking another action.';
  }
  if (plan.verificationStatus === 'skipped') {
    return 'The commands ran successfully, but this plan has no linked alert verification signal.';
  }
  return 'This plan has already left the approval queue. The execution timeline below shows what happened.';
}

function StepRow({ step, onRetry, retrying }: {
  step: RemediationPlanStep;
  onRetry: (ordinal: number) => void;
  retrying: boolean;
}) {
  const hasRuntimeDetail = Boolean(step.dryRunText || step.outputText || step.errorText);
  return (
    <li className="border border-[var(--color-outline-variant)] rounded-lg bg-[var(--color-surface-highest)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-[var(--color-surface-high)] px-2 text-xs font-semibold text-on-surface-variant">
              {step.ordinal + 1}
            </span>
            <StatusBadge status={step.status} />
            {step.continueOnError && (
              <span className="text-xs text-on-surface-variant">continues if this fails</span>
            )}
          </div>
          <h3 className="mt-3 text-base font-semibold text-on-surface">{stepTitle(step)}</h3>
          {step.riskNote && (
            <p className="mt-1 text-sm leading-6 text-on-surface-variant">{step.riskNote}</p>
          )}
        </div>
        {step.status === 'failed' && (
          <button
            type="button"
            disabled={retrying}
            onClick={() => onRetry(step.ordinal)}
            className="shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry this step'}
          </button>
        )}
      </div>

      <details className="mt-3 text-sm" open={step.status === 'failed'}>
        <summary className="cursor-pointer select-none text-on-surface-variant hover:text-on-surface">
          Command and run details
        </summary>
        <pre className="mt-2 font-mono text-sm whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-3 text-on-surface">
          {step.commandText}
        </pre>
        {step.dryRunText && (
          <pre className="mt-2 font-mono text-xs whitespace-pre-wrap bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-3 max-h-64 overflow-auto text-on-surface-variant">{step.dryRunText}</pre>
        )}
        {hasRuntimeDetail && (step.outputText || step.errorText) && (
          <pre className="mt-2 font-mono text-xs whitespace-pre-wrap bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-3 max-h-64 overflow-auto text-on-surface">
            {step.errorText ?? step.outputText}
          </pre>
        )}
      </details>
    </li>
  );
}

function DecisionPanel({
  plan,
  busy,
  canApprove,
  onApprove,
  onReject,
}: {
  plan: RemediationPlan;
  busy: boolean;
  canApprove: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const risk = planRisk(plan);
  const pending = plan.status === 'pending_approval';
  const verificationStatus = plan.verificationStatus ?? 'not_started';
  return (
    <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Decision</div>
          <h2 className="mt-2 text-xl font-semibold text-on-surface">{outcomeTitle(plan)}</h2>
          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            {outcomeDescription(plan)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={plan.status} />
          {plan.status !== 'pending_approval' && <VerificationBadge status={verificationStatus} />}
          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold uppercase ${RISK_STYLE[risk]}`}>
            {risk} risk
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Steps</div>
          <div className="mt-1 text-lg font-semibold text-on-surface">{plan.steps.length}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Target</div>
          <div className="mt-1 text-sm text-on-surface">{plan.targetObject || 'not recorded'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Validation</div>
          <div className="mt-1 text-sm text-on-surface">{plan.validationMethod || 'not recorded'}</div>
        </div>
      </div>

      {pending && (
        <div className="mt-5 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            disabled={!canApprove || busy}
            onClick={onApprove}
            className="px-4 py-2 rounded-md bg-primary text-on-primary-fixed font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Starting...' : 'Approve & run'}
          </button>
          <button
            type="button"
            disabled={!canApprove || busy}
            onClick={onReject}
            className="px-4 py-2 rounded-md border border-[var(--color-outline-variant)] text-on-surface hover:bg-[var(--color-surface-high)] disabled:opacity-50"
          >
            Reject
          </button>
          {!canApprove && (
            <span className="text-xs text-on-surface-variant">You need plan approval permission.</span>
          )}
        </div>
      )}
    </section>
  );
}

function SourcePanel({
  plan,
  alert,
  investigation,
}: {
  plan: RemediationPlan;
  alert: AlertRuleLite | null;
  investigation: InvestigationLite | null;
}) {
  if (!alert) {
    return (
      <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-4">
        <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Source</div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-on-surface">
            {investigation?.intent || `Investigation ${plan.investigationId.slice(0, 12)}...`}
          </span>
          {investigation?.status && <StatusBadge status={investigation.status as RemediationPlanStatus} />}
        </div>
        <div className="mt-2 text-xs text-on-surface-variant">
          <Link to={`/investigations/${plan.investigationId}`} className="text-[var(--color-primary)] hover:underline">
            View investigation
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Solves alert</div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="text-base font-semibold text-on-surface">{humanizeName(alert.name)}</span>
        <StatusPill kind="severity" value={alert.severity as 'critical' | 'high' | 'medium' | 'low'} size="md" />
        <span className="text-xs text-on-surface-variant">{alert.state}</span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs text-on-surface-variant flex-wrap">
        {alert.labels?.service && <span>service={alert.labels.service}</span>}
        {alert.labels?.namespace && <span>namespace={alert.labels.namespace}</span>}
        {alert.labels?.source_workload && <span>source={alert.labels.source_workload}</span>}
        <Link to={`/investigations/${plan.investigationId}`} className="text-[var(--color-primary)] hover:underline">
          View investigation
        </Link>
      </div>
    </section>
  );
}

function EvidenceGatePanel({ report }: { report: InvestigationReportLite | null }) {
  const gate = report?.provenance?.rootCauseGate;
  const passed = gate?.status === 'passed';
  return (
    <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Why trust it</div>
          <h2 className="mt-2 text-lg font-semibold text-on-surface">{rootCauseText(report)}</h2>
          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            {gate?.validationMethod || report?.summary || 'No investigation report was attached to this plan.'}
          </p>
        </div>
        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold uppercase ${
          passed ? 'bg-state-resolved/10 text-state-resolved' : 'bg-state-pending/10 text-state-pending'
        }`}>
          {passed ? 'verified' : 'not verified'}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Confidence</div>
          <div className="mt-1 text-sm font-semibold text-on-surface">{confidenceLabel(gate?.confidence)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Evidence</div>
          <div className="mt-1 text-sm font-semibold text-on-surface">{gate?.evidenceRefs.length ?? report?.provenance?.evidenceCount ?? 0}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Ruled out</div>
          <div className="mt-1 text-sm font-semibold text-on-surface">{gate?.ruledOut.length ?? 0}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Tool calls</div>
          <div className="mt-1 text-sm font-semibold text-on-surface">{report?.provenance?.toolCalls ?? 'unknown'}</div>
        </div>
      </div>

      {gate && gate.status !== 'passed' && gate.reasons.length > 0 && (
        <div className="mt-4 rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface)] p-3">
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Open concerns</div>
          <ul className="mt-2 space-y-1 text-sm text-on-surface-variant">
            {gate.reasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ChangePlanPanel({ plan }: { plan: RemediationPlan }) {
  return (
    <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">What will change</div>
      <h2 className="mt-2 text-lg font-semibold text-on-surface">{plan.summary}</h2>
      <div className="mt-4 divide-y divide-[var(--color-outline-variant)] border-y border-[var(--color-outline-variant)]">
        {plan.steps.map((step) => (
          <div key={step.id} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-on-surface">{stepTitle(step)}</div>
                <div className="mt-1 truncate font-mono text-xs text-on-surface-variant">{shortCommand(step.commandText)}</div>
              </div>
              <StatusBadge status={step.status} />
            </div>
            {step.riskNote && <p className="mt-2 text-sm leading-6 text-on-surface-variant">{step.riskNote}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function evidenceValue(evidence: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = evidence?.[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * The alert-rule snapshot the verifier nests under `rule` — see
 * `plan-verification-service.ts#ruleSnapshot`. Absent until the verifier has
 * resolved the linked rule.
 */
function evidenceRule(evidence: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const rule = evidence?.['rule'];
  return rule !== null && typeof rule === 'object' ? (rule as Record<string, unknown>) : null;
}

export function ValidationPanel({ plan, alert }: { plan: RemediationPlan; alert: AlertRuleLite | null }) {
  const status = plan.verificationStatus ?? 'not_started';
  const evidence = plan.verificationEvidenceJson;
  const alertState = evidenceValue(evidenceRule(evidence), 'state') ?? alert?.state ?? null;
  const observedAt = evidenceValue(evidence, 'checkedAt');
  const reason = evidenceValue(evidence, 'reason');
  const deadline = plan.verificationDeadlineAt ? expiryLabel(plan.verificationDeadlineAt) : null;
  return (
    <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">After approval validation</div>
          <h2 className="mt-2 text-lg font-semibold text-on-surface">
            {status === 'passed'
              ? 'Alert recovered after the change'
              : status === 'failed'
                ? 'Alert still firing after the change'
                : status === 'waiting'
                  ? 'Waiting for fresh alert evaluations'
                  : status === 'inconclusive'
                    ? 'Validation could not reach a clear result'
                    : status === 'skipped'
                      ? 'No linked validation signal'
                      : 'Validation has not started'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            {reason || plan.validationMethod || 'Rounds will only call this fixed when the linked alert or validation signal proves recovery.'}
          </p>
        </div>
        <VerificationBadge status={status} />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Linked alert</div>
          <div className="mt-1 text-sm text-on-surface">{plan.linkedAlertRuleId || 'none'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Alert state</div>
          <div className="mt-1 text-sm text-on-surface">{alertState || 'unknown'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Deadline</div>
          <div className="mt-1 text-sm text-on-surface">{deadline || 'none'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Observed</div>
          <div className="mt-1 text-sm text-on-surface">{observedAt ? relativeTime(observedAt) : 'not yet'}</div>
        </div>
      </div>

      {status === 'failed' && (
        <div className="mt-4 rounded-md border border-severity-critical/20 bg-severity-critical/10 p-3 text-sm text-severity-critical">
          The change was applied, but the alert did not recover. Treat this plan as disproven evidence before approving another fix.
        </div>
      )}
      {status === 'inconclusive' && (
        <div className="mt-4 rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface)] p-3 text-sm text-on-surface-variant">
          Verification could not prove success or failure. Continue investigation with this result attached instead of repeating the same fix.
        </div>
      )}
    </section>
  );
}

/**
 * Rescue-plan entry point. Only failed executions have anything to roll back,
 * and the executor writes `execution_failed` (`failed` is the pre-rename
 * value still present on older rows). Exported for tests.
 */
export function RescuePlanPanel({ plan, rescuePlan }: { plan: RemediationPlan; rescuePlan: RemediationPlan | null }) {
  if (plan.status !== 'execution_failed' && plan.status !== 'failed') return null;
  if (!rescuePlan) return null;
  return (
    <div className="border border-[var(--color-outline-variant)] rounded-xl p-4 bg-[var(--color-surface-highest)]">
      <h3 className="font-semibold text-on-surface mb-1">Rescue plan available</h3>
      <p className="text-sm text-on-surface-variant mb-3">A paired rollback plan was generated alongside this plan. It will not run automatically.</p>
      <Link
        to={`/plans/${rescuePlan.id}`}
        className="inline-block px-4 py-2 rounded-md bg-primary text-on-primary-fixed font-semibold hover:opacity-90"
      >
        Open rescue plan
      </Link>
    </div>
  );
}

/**
 * `apiClient` resolves API failures into `{ data, error }` rather than
 * throwing, so plan mutations must inspect the envelope — a bare `await`
 * makes a rejected approve look like a successful one. Returns the message to
 * show the operator, or null when the call succeeded. Exported for tests.
 */
export async function planActionError(
  label: string,
  call: () => Promise<ApiResponse<unknown>>,
): Promise<string | null> {
  const { error } = await call();
  return error ? `${label} failed: ${error.message}` : null;
}

export default function PlanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [rescuePlan, setRescuePlan] = useState<RemediationPlan | null>(null);
  const [sourceAlert, setSourceAlert] = useState<AlertRuleLite | null>(null);
  const [sourceInvestigation, setSourceInvestigation] = useState<InvestigationLite | null>(null);
  const [investigationReport, setInvestigationReport] = useState<InvestigationReportLite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryingOrdinal, setRetryingOrdinal] = useState<number | null>(null);

  const canApprove = hasPermission('plans:approve');

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await plansApi.get(id);
      setPlan(data);
      setError(null);
      // Look up a paired rescue plan in the same investigation, if any.
      if (data.investigationId) {
        const list = await plansApi.list({ investigationId: data.investigationId });
        const rescue = list.data.find((p) => p.rescueForPlanId === data.id);
        setRescuePlan(rescue ?? null);
        const investigation = await apiClient.get<InvestigationLite>(`/investigations/${data.investigationId}`);
        setSourceInvestigation(investigation.error ? null : investigation.data);
        const report = await apiClient.get<InvestigationReportLite>(`/investigations/${data.investigationId}/report`);
        setInvestigationReport(report.error ? null : report.data);
        const alerts = await apiClient.get<AlertRulesResponse | { list: AlertRuleLite[] }>('/alert-rules');
        if (!alerts.error) {
          const rules = Array.isArray(alerts.data) ? alerts.data : alerts.data.list ?? [];
          setSourceAlert(
            rules.find((r) => data.linkedAlertRuleId && r.id === data.linkedAlertRuleId)
              ?? rules.find((r) => r.investigationId === data.investigationId)
              ?? null,
          );
        }
      } else {
        setRescuePlan(null);
        setSourceAlert(null);
        setSourceInvestigation(null);
        setInvestigationReport(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plan');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAction = async (label: string, call: () => Promise<ApiResponse<unknown>>) => {
    setActionError(null);
    const message = await planActionError(label, call);
    if (message) {
      setActionError(message);
      return;
    }
    await reload();
  };

  const handleApprove = async () => {
    if (!id) return;
    setBusy(true);
    await runAction('Approve', () => plansApi.approve(id, true));
    setBusy(false);
  };

  const handleReject = async () => {
    if (!id) return;
    setBusy(true);
    await runAction('Reject', () => plansApi.reject(id));
    setBusy(false);
  };

  const handleCancel = async () => {
    if (!id) return;
    setBusy(true);
    await runAction('Cancel', () => plansApi.cancel(id));
    setBusy(false);
  };

  const handleRetry = async (ordinal: number) => {
    if (!id) return;
    setRetryingOrdinal(ordinal);
    await runAction('Retry', () => plansApi.retryStep(id, ordinal));
    setRetryingOrdinal(null);
  };

  const expiresLabel = useMemo(() => {
    if (!plan) return '';
    const label = expiryLabel(plan.expiresAt);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }, [plan]);

  if (loading) return <div className="p-6 text-on-surface-variant">Loading plan…</div>;
  if (error && !plan) return (
    <div className="p-6">
      <p className="text-severity-critical">{error}</p>
      <button type="button" onClick={() => navigate('/actions')} className="mt-4 underline">Back</button>
    </div>
  );
  if (!plan) return null;

  const canCancel = plan.status === 'approved' || plan.status === 'executing';

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/actions" className="text-on-surface-variant hover:underline">← Action Center</Link>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-on-surface">Fix plan</h1>
          <StatusBadge status={plan.status} />
          {plan.autoEdit && plan.status !== 'pending_approval' && (
            <StatusPill kind="severity" value="info" label="auto-edit" size="md" />
          )}
        </div>
        <p className="max-w-3xl text-on-surface-variant leading-7">{plan.summary}</p>
        <div className="text-sm text-on-surface-variant flex items-center gap-3 flex-wrap">
          <span>Created {relativeTime(plan.createdAt)} by {plan.createdBy}</span>
          <span>•</span>
          <Link to={`/investigations/${plan.investigationId}`} className="hover:underline">
            Investigation {plan.investigationId.slice(0, 12)}…
          </Link>
          <span>•</span>
          {/* expiryLabel already reads "Expires in 32m" / "Expired 5m ago". */}
          <span>{expiresLabel}</span>
        </div>
        {plan.rescueForPlanId && (
          <div className="text-sm text-on-surface-variant">
            <span>This is a rescue plan for </span>
            <Link to={`/plans/${plan.rescueForPlanId}`} className="hover:underline">{plan.rescueForPlanId.slice(0, 12)}…</Link>
          </div>
        )}
      </div>

      {error && <p className="text-severity-critical">{error}</p>}

      {/* Action error toast */}
      {actionError && (
        <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-severity-critical/10 border border-severity-critical/20 text-sm text-severity-critical">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-3 text-severity-critical/70 hover:text-severity-critical font-semibold"
          >
            x
          </button>
        </div>
      )}

      <DecisionPanel
        plan={plan}
        busy={busy}
        canApprove={canApprove}
        onApprove={handleApprove}
        onReject={handleReject}
      />

      <SourcePanel plan={plan} alert={sourceAlert} investigation={sourceInvestigation} />

      <ValidationPanel plan={plan} alert={sourceAlert} />

      <EvidenceGatePanel report={investigationReport} />

      <ChangePlanPanel plan={plan} />

      <div>
        <h2 className="text-lg font-semibold text-on-surface mb-3">Execution timeline</h2>
        <ol className="space-y-3">
          {plan.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              onRetry={handleRetry}
              retrying={retryingOrdinal === step.ordinal}
            />
          ))}
        </ol>
      </div>

      {/* Cancel control */}
      {canCancel && canApprove && (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={handleCancel}
            className="px-4 py-2 rounded-md border border-[var(--color-outline-variant)] text-sm hover:bg-[var(--color-surface-high)] disabled:opacity-50"
          >
            Cancel plan
          </button>
        </div>
      )}

      {/* Rescue plan link on failed plans */}
      <RescuePlanPanel plan={plan} rescuePlan={rescuePlan} />
    </div>
  );
}
