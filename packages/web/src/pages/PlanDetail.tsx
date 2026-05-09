/**
 * /plans/:id — review + approve a single RemediationPlan.
 *
 * P7 of `docs/design/auto-remediation.md`. Shows the plan summary, source
 * investigation, ordered step list with dry-run previews + risk notes,
 * and an approve form with an opt-in `auto-edit` checkbox (gated by
 * `plans:auto_edit`). Failed plans get a "retry this step" affordance.
 * Plans with a rescue plan get a "Run rescue plan" link.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { plansApi } from '../api/client.js';
import type {
  RemediationPlan,
  RemediationPlanStep,
  RemediationPlanStatus,
  RemediationPlanStepStatus,
} from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { relativeTime } from '../utils/time.js';
import RiskAwareConfirm from '../components/RiskAwareConfirm.js';
import type { RiskAwareRisk } from '../components/RiskAwareConfirm.js';
import StatusPill from '../components/StatusPill.js';

/**
 * Pick a display risk for the plan as a whole.
 *
 * Plans are background_agent-sourced, so the confirmation surface is
 * `formal_approval`. Risk drives friction: any write-style step yields
 * `high`; ops.run_command with a destructive verb (delete/drain) yields
 * `critical`. Everything else stays `medium`.
 */
function pickPlanRisk(plan: RemediationPlan): RiskAwareRisk {
  const argvs = plan.steps
    .map((s) => {
      const params = (s as unknown as { params?: { argv?: unknown } }).params;
      return Array.isArray(params?.argv) ? (params!.argv as string[]) : [];
    })
    .flat()
    .map((v) => String(v).toLowerCase());
  if (argvs.some((v) => v === 'delete' || v === 'drain')) return 'critical';
  if (plan.steps.length > 0) return 'high';
  return 'medium';
}

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

export default function PlanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [rescuePlan, setRescuePlan] = useState<RemediationPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoEdit, setAutoEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryingOrdinal, setRetryingOrdinal] = useState<number | null>(null);

  const canApprove = hasPermission('plans:approve');
  const canAutoEdit = hasPermission('plans:auto_edit');

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
      await plansApi.approve(id, autoEdit && canAutoEdit);
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
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/actions" className="text-on-surface-variant hover:underline">← Action Center</Link>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-on-surface">Remediation Plan</h1>
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

      <div>
        <h2 className="text-lg font-semibold text-on-surface mb-3">Steps</h2>
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

      {/* Approval surface — plans come from the background agent so the
          confirmation surface is the formal_approval path: Approve / Reject. */}
      {isPending && canApprove && (
        <RiskAwareConfirm
          risk={pickPlanRisk(plan)}
          mode="formal_approval"
          resourceName={plan.investigationId.slice(0, 12)}
          busy={busy}
          onConfirm={handleApprove}
          onCancel={handleReject}
          summary={
            <div>
              <div className="font-semibold mb-1">Review</div>
              {canAutoEdit && (
                <label className="flex items-start gap-2 text-sm cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={autoEdit}
                    onChange={(e) => setAutoEdit(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-semibold">Auto-edit subsequent steps.</span>{' '}
                    <span className="text-on-surface-variant">
                      When checked, the executor runs every step without asking for per-step approval.
                    </span>
                  </span>
                </label>
              )}
            </div>
          }
          approvalContext={
            <div>
              From investigation {plan.investigationId.slice(0, 12)}… • {plan.steps.length} step
              {plan.steps.length === 1 ? '' : 's'} • created by {plan.createdBy}
            </div>
          }
          dryRun={
            <ol className="space-y-1 max-h-64 overflow-auto font-mono text-xs">
              {plan.steps.map((s) => (
                <li key={s.id} className="text-on-surface-variant">
                  step {s.ordinal + 1}: {s.commandText}
                </li>
              ))}
            </ol>
          }
        />
      )}

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
