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
} from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { relativeTime } from '../utils/time.js';
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

function StepRow({ step, onRetry, retrying }: {
  step: RemediationPlanStep;
  onRetry: (ordinal: number) => void;
  retrying: boolean;
}) {
  return (
    <li className="border border-[var(--color-outline-variant)] rounded-lg bg-[var(--color-surface-highest)] p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-on-surface-variant">step {step.ordinal + 1}</span>
          <StatusBadge status={step.status} />
          {step.continueOnError && (
            <span className="text-xs text-on-surface-variant italic">continue-on-error</span>
          )}
        </div>
        {step.status === 'failed' && (
          <button
            type="button"
            disabled={retrying}
            onClick={() => onRetry(step.ordinal)}
            className="px-3 py-1 rounded-md text-xs font-semibold border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry this step'}
          </button>
        )}
      </div>
      <pre className="mt-2 font-mono text-sm whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2 text-on-surface">
        {step.commandText}
      </pre>
      {step.riskNote && (
        <p className="mt-2 text-sm text-on-surface-variant">
          <span className="font-semibold">Risk: </span>{step.riskNote}
        </p>
      )}
      {step.dryRunText && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-on-surface-variant">Dry-run preview</summary>
          <pre className="mt-1 font-mono text-xs whitespace-pre-wrap bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2 max-h-64 overflow-auto">{step.dryRunText}</pre>
        </details>
      )}
      {(step.outputText || step.errorText) && (
        <details className="mt-2 text-sm" open={Boolean(step.errorText)}>
          <summary className="cursor-pointer text-on-surface-variant">
            {step.errorText ? 'Error output' : 'Output'}
          </summary>
          <pre className="mt-1 font-mono text-xs whitespace-pre-wrap bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2 max-h-64 overflow-auto">
            {step.errorText ?? step.outputText}
          </pre>
        </details>
      )}
    </li>
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

function ApprovalReviewCard({
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
  return (
    <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-outline)] font-semibold">Review required</div>
          <h2 className="mt-1 text-lg font-semibold text-on-surface">Approve this fix to run {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">Review the commands below. Approval runs this plan once; it does not change future policy.</p>
        </div>
        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold uppercase ${RISK_STYLE[risk]}`}>
          {risk} risk
        </span>
      </div>

      <div className="grid gap-2">
        {plan.steps.map((step) => (
          <div key={step.id} className="rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface)] p-3">
            <div className="flex items-center gap-2 text-xs text-on-surface-variant">
              <span className="font-semibold text-on-surface">{commandVerb(step)}</span>
              <span>{commandTarget(step)}</span>
            </div>
            <code className="mt-1 block text-sm font-mono text-on-surface break-all">{step.commandText}</code>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={!canApprove || busy}
          onClick={onApprove}
          className="px-4 py-2 rounded-md bg-primary text-on-primary-fixed font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Working...' : 'Approve & run'}
        </button>
        <button
          type="button"
          disabled={!canApprove || busy}
          onClick={onReject}
          className="px-4 py-2 rounded-md border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] disabled:opacity-50"
        >
          Reject
        </button>
        {!canApprove && (
          <span className="text-xs text-on-surface-variant">You need plan approval permission.</span>
        )}
      </div>
    </section>
  );
}

export default function PlanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [rescuePlan, setRescuePlan] = useState<RemediationPlan | null>(null);
  const [sourceAlert, setSourceAlert] = useState<AlertRuleLite | null>(null);
  const [sourceInvestigation, setSourceInvestigation] = useState<InvestigationLite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        const alerts = await apiClient.get<AlertRulesResponse | { list: AlertRuleLite[] }>('/alert-rules');
        if (!alerts.error) {
          const rules = Array.isArray(alerts.data) ? alerts.data : alerts.data.list ?? [];
          setSourceAlert(rules.find((r) => r.investigationId === data.investigationId) ?? null);
        }
      } else {
        setRescuePlan(null);
        setSourceAlert(null);
        setSourceInvestigation(null);
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

  const handleApprove = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await plansApi.approve(id, true);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await plansApi.reject(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await plansApi.cancel(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (ordinal: number) => {
    if (!id) return;
    setRetryingOrdinal(ordinal);
    try {
      await plansApi.retryStep(id, ordinal);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetryingOrdinal(null);
    }
  };

  const expiresLabel = useMemo(() => {
    if (!plan) return '';
    return relativeTime(plan.expiresAt);
  }, [plan]);

  if (loading) return <div className="p-6 text-on-surface-variant">Loading plan…</div>;
  if (error && !plan) return (
    <div className="p-6">
      <p className="text-severity-critical">{error}</p>
      <button type="button" onClick={() => navigate('/actions')} className="mt-4 underline">Back</button>
    </div>
  );
  if (!plan) return null;

  const isPending = plan.status === 'pending_approval';
  const canCancel = plan.status === 'approved' || plan.status === 'executing';

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/actions" className="text-on-surface-variant hover:underline">← Action Center</Link>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-on-surface">Review Fix</h1>
          <StatusBadge status={plan.status} />
          {plan.autoEdit && plan.status !== 'pending_approval' && (
            <StatusPill kind="severity" value="info" label="auto-edit" size="md" />
          )}
        </div>
        <p className="text-on-surface">{plan.summary}</p>
        <div className="text-sm text-on-surface-variant flex items-center gap-4 flex-wrap">
          <span>Created {relativeTime(plan.createdAt)} by {plan.createdBy}</span>
          <span>•</span>
          <span>Expires {expiresLabel}</span>
          <span>•</span>
          <Link to={`/investigations/${plan.investigationId}`} className="hover:underline">
            From investigation {plan.investigationId.slice(0, 12)}…
          </Link>
        </div>
        {plan.rescueForPlanId && (
          <div className="text-sm text-on-surface-variant">
            <span>This is a rescue plan for </span>
            <Link to={`/plans/${plan.rescueForPlanId}`} className="hover:underline">{plan.rescueForPlanId.slice(0, 12)}…</Link>
          </div>
        )}
      </div>

      {error && <p className="text-severity-critical">{error}</p>}

      <SourcePanel plan={plan} alert={sourceAlert} investigation={sourceInvestigation} />

      {isPending && (
        <ApprovalReviewCard
          plan={plan}
          busy={busy}
          canApprove={canApprove}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      <div>
        <h2 className="text-lg font-semibold text-on-surface mb-3">Execution steps</h2>
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
      {plan.status === 'failed' && rescuePlan && (
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
      )}
    </div>
  );
}
