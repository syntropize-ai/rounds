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

  const execute = async () => {
    setBusy(true);
    try {
      const { data, error: apiError } = await apiClient.post<{
        result?: { observation?: string };
        confirmation?: { status?: typeof status };
      }>(`/ops-command-confirmations/${encodeURIComponent(confirmation.id)}/execute`, {});
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
      status === 'executed' ? 'Running' :
      status === 'rejected' ? 'Cancelled' :
      status === 'expired' ? 'Expired' :
      status === 'failed' ? 'Failed' : status;
    return (
      <div className="text-xs text-on-surface-variant">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-2 hover:text-on-surface"
        >
          <span>{glyph}</span>
          <span>{verb} ops command on {confirmation.connectorId}</span>
          <span className="opacity-60">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <pre className="mt-2 font-mono whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2">
            {confirmation.command}
          </pre>
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
    <div className="border border-[var(--color-outline-variant)] rounded-lg p-4 bg-[var(--color-surface-highest)] space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-on-surface">Confirm ops command</div>
          <div className="text-xs text-on-surface-variant">{confirmation.connectorId}</div>
        </div>
        <span className="text-xs uppercase tracking-wide text-on-surface-variant">{status}</span>
      </div>
      <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2">
        {confirmation.command}
      </pre>
      {confirmation.summary && (
        <p className="text-sm text-on-surface-variant">{confirmation.summary}</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={execute}
          className="px-3 py-2 rounded-md bg-primary text-on-primary-fixed font-semibold disabled:opacity-50"
        >
          {busy ? 'Working...' : 'Yes, run'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={reject}
          className="px-3 py-2 rounded-md border border-[var(--color-outline-variant)] disabled:opacity-50"
        >
          No, cancel
        </button>
      </div>
      {output && (
        <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded p-2">
          {output}
        </pre>
      )}
    </div>
  );
}
