import React, { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';

export default function OpsCommandConfirmCard({
  confirmation,
  onResolved,
}: {
  confirmation: NonNullable<ChatEvent['opsConfirmation']>;
  onResolved?: (confirmation: NonNullable<ChatEvent['opsConfirmation']>) => void;
}) {
  const [status, setStatus] = useState(confirmation.status ?? 'pending');
  const [output, setOutput] = useState(confirmation.output ?? '');
  const [error, setError] = useState(confirmation.error ?? '');
  const [busy, setBusy] = useState(false);
  const [rememberBusy, setRememberBusy] = useState(false);
  useEffect(() => {
    // Only adopt the prop when it's a RESOLVED (non-pending) status. The
    // parent overlay-merge is async, so right after an optimistic
    // setStatus('executed') the prop can still read 'pending' for a render;
    // without this guard the effect would downgrade the optimistic status
    // back to pending and the card looks frozen.
    if (
      confirmation.status &&
      confirmation.status !== 'pending' &&
      confirmation.status !== status
    ) {
      setStatus(confirmation.status);
      setOutput(confirmation.output ?? '');
      setError(confirmation.error ?? '');
    }
  }, [confirmation.status, confirmation.output, confirmation.error, status]);

  const execute = async (remember = false) => {
    if (remember) setRememberBusy(true);
    else setBusy(true);
    try {
      const { data, error: apiError } = await apiClient.post<{
        result?: { observation?: string };
        confirmation?: { status?: typeof status };
      }>(`/ops-command-confirmations/${encodeURIComponent(confirmation.id)}/execute`, remember ? { remember: true } : {});
      if (apiError) {
        if (
          apiError.code === 'CONFIRMATION_UNAVAILABLE' ||
          apiError.code === 'NOT_FOUND' ||
          (apiError as { status?: number }).status === 404 ||
          (apiError as { status?: number }).status === 410
        ) {
          const message =
            apiError.message ||
            'This confirmation is no longer available. Ask Rounds to propose the command again.';
          setStatus('expired');
          setError(message);
          onResolved?.({ ...confirmation, status: 'expired', error: message });
          return;
        }
        // 409 = the command already ran (or was already rejected) on a prior
        // click. It's resolved, not failed — reflect the real terminal status
        // instead of throwing a scary "failed".
        if (
          apiError.code === 'CONFLICT' ||
          (apiError as { status?: number }).status === 409
        ) {
          const resolvedStatus = /reject/i.test(apiError.message ?? '')
            ? 'rejected'
            : 'executed';
          setStatus(resolvedStatus);
          onResolved?.({ ...confirmation, status: resolvedStatus });
          return;
        }
        throw new Error(apiError.message);
      }
      const nextStatus = data?.confirmation?.status ?? 'executed';
      setStatus(nextStatus);
      setOutput(data?.result?.observation ?? '');
      onResolved?.({ ...confirmation, status: nextStatus });
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : 'Command failed');
    } finally {
      setBusy(false);
      setRememberBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      const { error: apiError } = await apiClient.post(
        `/ops-command-confirmations/${encodeURIComponent(confirmation.id)}/reject`,
        {},
      );
      if (apiError) {
        if (
          apiError.code === 'CONFIRMATION_UNAVAILABLE' ||
          apiError.code === 'NOT_FOUND' ||
          (apiError as { status?: number }).status === 404 ||
          (apiError as { status?: number }).status === 410
        ) {
          const message =
            apiError.message ||
            'This confirmation is no longer available. Ask Rounds to propose the command again.';
          setStatus('expired');
          setError(message);
          onResolved?.({ ...confirmation, status: 'expired', error: message });
          return;
        }
        throw new Error(apiError.message);
      }
      setStatus('rejected');
      onResolved?.({ ...confirmation, status: 'rejected' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  const resolved = status !== 'pending';
  const [expanded, setExpanded] = useState(false);

  if (resolved) {
    const glyph =
      status === 'executed' ? '✓' :
      status === 'rejected' ? '✕' :
      status === 'failed' ? '!' : '·';
    const verb =
      status === 'executed' ? 'Ran' :
      status === 'rejected' ? 'Cancelled' :
      status === 'expired' ? 'Expired' :
      status === 'failed' ? 'Failed' : status;
    // Show the command itself as the label (Claude-Code style) — the connector
    // id is an opaque UUID and tells the user nothing. Full command + output
    // reveal on expand.
    const label = confirmation.command || `ops command on ${confirmation.connectorId}`;
    return (
      <div className="text-xs text-on-surface-variant">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 hover:text-on-surface max-w-full text-left"
          title={confirmation.command}
        >
          <span className="shrink-0">{glyph}</span>
          <span className="shrink-0 opacity-70">{verb}</span>
          <span className="font-mono truncate">{label}</span>
          <span className="shrink-0 opacity-60">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <>
            <pre className="mt-2 font-mono whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2">
              {confirmation.command}
            </pre>
            {output && (
              <pre className="mt-1 font-mono whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2 max-h-64 overflow-auto opacity-90">
                {output}
              </pre>
            )}
          </>
        )}
        {error && (
          <pre className="mt-2 font-mono whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2 text-error">
            {error}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-xl border border-[var(--color-outline-variant)] bg-[var(--color-surface)] shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--color-outline-variant)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-on-surface">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-outline-variant)] text-[11px] text-on-surface-variant">
              $
            </span>
            <span>Run command?</span>
          </div>
          <div className="mt-1 truncate text-xs text-on-surface-variant">
            {confirmation.capability ?? 'ops command'} on {confirmation.connectorId}
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--color-outline-variant)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
          {status}
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-[12px] leading-relaxed text-on-surface">
          {confirmation.command}
        </pre>
        {confirmation.summary && (
          <p className="text-sm leading-relaxed text-on-surface-variant">{confirmation.summary}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-outline-variant)] px-4 py-3">
        <button
          type="button"
          disabled={busy || rememberBusy}
          onClick={() => execute(false)}
          className="rounded-lg bg-on-surface px-3 py-1.5 text-sm font-medium text-surface transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Running...' : 'Run'}
        </button>
        <button
          type="button"
          disabled={busy || rememberBusy}
          onClick={() => execute(true)}
          className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-on-surface transition hover:bg-[var(--color-surface-container-low)] disabled:opacity-50"
          title="Run this command and allow this connector capability in the future"
        >
          {rememberBusy ? 'Saving...' : 'Always allow'}
        </button>
        <button
          type="button"
          disabled={busy || rememberBusy}
          onClick={reject}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-on-surface-variant transition hover:bg-[var(--color-surface-container-low)] hover:text-on-surface disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {output && (
        <pre className="mx-4 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-container-low)] p-3 font-mono text-xs">
          {output}
        </pre>
      )}
      {error && (
        <pre className="mx-4 mb-3 whitespace-pre-wrap break-all rounded-lg border border-error/40 bg-error/5 p-3 font-mono text-xs text-error">
          {error}
        </pre>
      )}
    </div>
  );
}
