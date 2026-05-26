import React, { useEffect, useState } from 'react';
import { pendingChangesApi } from '../../api/client.js';
import type { PendingChangeKind, PendingChangeStatus } from '../../types/pending-changes.js';

interface DashboardChangeConfirmCardProps {
  proposalId: string;
  dashboardId: string;
  panelId: string | null;
  changeKind: PendingChangeKind;
  summary: string;
  initialStatus?: PendingChangeStatus;
  controlledStatus?: PendingChangeStatus;
  onResolved?: (status: PendingChangeStatus) => void;
}

export default function DashboardChangeConfirmCard({
  proposalId,
  dashboardId,
  panelId,
  changeKind,
  summary,
  initialStatus = 'pending',
  controlledStatus,
  onResolved,
}: DashboardChangeConfirmCardProps) {
  const [status, setStatus] = useState<PendingChangeStatus>(controlledStatus ?? initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (controlledStatus && controlledStatus !== status) {
      setStatus(controlledStatus);
    }
  }, [controlledStatus, status]);

  const resolve = async (next: 'accepted' | 'rejected') => {
    setBusy(true);
    setError('');
    try {
      if (next === 'accepted') {
        await pendingChangesApi.accept(dashboardId, proposalId);
        window.dispatchEvent(new CustomEvent('dashboard:refresh-panels', {
          detail: { dashboardId },
        }));
      } else {
        await pendingChangesApi.reject(dashboardId, proposalId);
      }
      setStatus(next);
      onResolved?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setBusy(false);
    }
  };

  if (status !== 'pending') {
    const glyph = status === 'accepted' ? '✓' : status === 'rejected' ? '✕' : '·';
    const label = status === 'accepted' ? 'Applied dashboard change' :
      status === 'rejected' ? 'Cancelled dashboard change' :
        'Dashboard change expired';
    return (
      <div className="text-xs text-on-surface-variant">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-2 hover:text-on-surface"
        >
          <span>{glyph}</span>
          <span>{label}</span>
          <span className="opacity-60">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <pre className="mt-2 font-mono whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2">
            {summary}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="border border-[var(--color-outline-variant)] rounded-lg p-4 bg-[var(--color-surface-highest)] space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-on-surface">Confirm dashboard change</div>
          <div className="text-xs text-on-surface-variant">
            {changeKind}{panelId ? ` · ${panelId}` : ''}
          </div>
        </div>
        <span className="text-xs uppercase tracking-wide text-on-surface-variant">pending</span>
      </div>
      <p className="text-sm text-on-surface">{summary}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve('accepted')}
          className="px-3 py-2 rounded-md bg-primary text-on-primary-fixed font-semibold disabled:opacity-50"
        >
          {busy ? 'Working...' : 'Yes, apply'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve('rejected')}
          className="px-3 py-2 rounded-md border border-[var(--color-outline-variant)] disabled:opacity-50"
        >
          No, cancel
        </button>
      </div>
      {error && (
        <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2 text-error">
          {error}
        </pre>
      )}
    </div>
  );
}
