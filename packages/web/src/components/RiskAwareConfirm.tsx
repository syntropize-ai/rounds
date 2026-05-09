/**
 * RiskAwareConfirm — confirmation surface keyed off (risk, mode).
 *
 * Two distinct UX paths:
 *
 *   mode='user_confirm' / 'strong_user_confirm'  → user-driven actions in
 *     conversation or manual UI. Wording: "Run / Confirm / Apply / Cancel".
 *     Does NOT imply an ApprovalRequest row — caller decides post-confirm
 *     whether to escalate.
 *
 *   mode='formal_approval' → background-agent action that requires a
 *     formal approval. Wording: "Approve / Reject / Modify". Caller is
 *     expected to render the approval context (owner/oncall/team), evidence
 *     and rollback in the supplied slots.
 *
 * The risk level controls friction:
 *   low      → single confirm click
 *   medium   → "I understand" checkbox before confirm
 *   high     → type the resource name + dry-run/diff visible
 *   critical → type the resource name + 30s countdown disable
 */

import React, { useEffect, useMemo, useState } from 'react';

export type RiskAwareRisk = 'low' | 'medium' | 'high' | 'critical';
export type RiskAwareMode = 'user_confirm' | 'strong_user_confirm' | 'formal_approval';

export interface RiskAwareWording {
  confirm: string;
  cancel: string;
  rejectExtra?: string; // formal_approval surfaces a third "Reject" verb
  modifyExtra?: string; // formal_approval optional "Modify"
}

/** Pure: pick the verb set for (mode, risk). Exported for tests. */
export function pickWording(mode: RiskAwareMode, risk: RiskAwareRisk): RiskAwareWording {
  if (mode === 'formal_approval') {
    return {
      confirm: 'Approve',
      cancel: 'Reject',
      rejectExtra: 'Reject',
      modifyExtra: 'Modify',
    };
  }
  // user_confirm and strong_user_confirm share verbs; risk drives friction.
  if (risk === 'critical' || risk === 'high') {
    return { confirm: 'Apply', cancel: 'Cancel' };
  }
  if (risk === 'medium') {
    return { confirm: 'Confirm', cancel: 'Cancel' };
  }
  return { confirm: 'Run', cancel: 'Cancel' };
}

/** Pure: which friction layers are required at this risk. Exported for tests. */
export function requiredFriction(risk: RiskAwareRisk): {
  understandCheckbox: boolean;
  typeResourceName: boolean;
  showDryRun: boolean;
  countdownSeconds: number;
} {
  if (risk === 'critical') {
    return {
      understandCheckbox: false,
      typeResourceName: true,
      showDryRun: true,
      countdownSeconds: 30,
    };
  }
  if (risk === 'high') {
    return {
      understandCheckbox: false,
      typeResourceName: true,
      showDryRun: true,
      countdownSeconds: 0,
    };
  }
  if (risk === 'medium') {
    return {
      understandCheckbox: true,
      typeResourceName: false,
      showDryRun: false,
      countdownSeconds: 0,
    };
  }
  return {
    understandCheckbox: false,
    typeResourceName: false,
    showDryRun: false,
    countdownSeconds: 0,
  };
}

export interface RiskAwareConfirmProps {
  risk: RiskAwareRisk;
  mode: RiskAwareMode;
  resourceName?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onModify?: () => void;
  /** Inline diff/dry-run preview content. */
  dryRun?: React.ReactNode;
  /** Investigation/evidence summary shown above the buttons. */
  summary?: React.ReactNode;
  /** Approval-context block for formal_approval mode (owner/oncall/team). */
  approvalContext?: React.ReactNode;
  busy?: boolean;
}

const RISK_BADGE: Record<RiskAwareRisk, string> = {
  low: 'bg-[var(--color-surface-high)] text-on-surface-variant',
  medium: 'bg-[#F59E0B]/10 text-[#F59E0B]',
  high: 'bg-[#F97316]/10 text-[#F97316]',
  critical: 'bg-[#EF4444]/10 text-[#EF4444]',
};

export default function RiskAwareConfirm({
  risk,
  mode,
  resourceName,
  onConfirm,
  onCancel,
  onModify,
  dryRun,
  summary,
  approvalContext,
  busy,
}: RiskAwareConfirmProps) {
  const friction = useMemo(() => requiredFriction(risk), [risk]);
  const wording = useMemo(() => pickWording(mode, risk), [mode, risk]);

  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(friction.countdownSeconds);

  useEffect(() => {
    setSecondsLeft(friction.countdownSeconds);
    if (friction.countdownSeconds <= 0) return;
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = Math.max(0, friction.countdownSeconds - elapsed);
      setSecondsLeft(remaining);
      if (remaining === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [friction.countdownSeconds]);

  const understandSatisfied = !friction.understandCheckbox || understood;
  const typeSatisfied =
    !friction.typeResourceName || (resourceName !== undefined && typed === resourceName);
  const countdownSatisfied = secondsLeft <= 0;
  const confirmEnabled =
    !busy && understandSatisfied && typeSatisfied && countdownSatisfied;

  return (
    <div
      data-testid="risk-aware-confirm"
      data-risk={risk}
      data-mode={mode}
      className="border border-[var(--color-outline-variant)] rounded-xl p-4 space-y-3 bg-[var(--color-surface-highest)]"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${RISK_BADGE[risk]}`}
        >
          {risk}
        </span>
        <span className="text-xs text-[var(--color-outline)] uppercase tracking-wide">
          {mode === 'formal_approval' ? 'formal approval' : 'user confirmation'}
        </span>
        {resourceName && (
          <span className="font-mono text-xs text-on-surface-variant">{resourceName}</span>
        )}
      </div>

      {summary && <div className="text-sm text-on-surface">{summary}</div>}

      {mode === 'formal_approval' && approvalContext && (
        <div className="text-xs text-on-surface-variant border-l-2 border-[var(--color-outline-variant)] pl-3">
          {approvalContext}
        </div>
      )}

      {friction.showDryRun && dryRun && (
        <div className="text-xs">
          <div className="text-on-surface-variant font-semibold mb-1">Dry-run / diff</div>
          {dryRun}
        </div>
      )}

      {friction.understandCheckbox && (
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            data-testid="rac-understand"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            className="mt-1"
          />
          <span>I understand the impact of this change.</span>
        </label>
      )}

      {friction.typeResourceName && resourceName && (
        <div className="text-sm">
          <label className="block mb-1 text-on-surface-variant">
            Type <span className="font-mono">{resourceName}</span> to confirm:
          </label>
          <input
            type="text"
            data-testid="rac-type-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface)] font-mono text-sm"
          />
        </div>
      )}

      {friction.countdownSeconds > 0 && secondsLeft > 0 && (
        <div data-testid="rac-countdown" className="text-xs text-[#EF4444]">
          Confirm available in {secondsLeft}s.
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button
          type="button"
          data-testid="rac-confirm"
          disabled={!confirmEnabled}
          onClick={onConfirm}
          className="px-4 py-2 rounded-md bg-primary text-on-primary-fixed font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Working…' : wording.confirm}
        </button>
        <button
          type="button"
          data-testid="rac-cancel"
          disabled={busy}
          onClick={onCancel}
          className="px-4 py-2 rounded-md border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] disabled:opacity-50"
        >
          {wording.cancel}
        </button>
        {mode === 'formal_approval' && onModify && (
          <button
            type="button"
            data-testid="rac-modify"
            disabled={busy}
            onClick={onModify}
            className="px-4 py-2 rounded-md border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] disabled:opacity-50"
          >
            {wording.modifyExtra ?? 'Modify'}
          </button>
        )}
      </div>
    </div>
  );
}
