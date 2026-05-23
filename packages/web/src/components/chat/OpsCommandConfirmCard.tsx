import React, { useState } from 'react';
import { apiClient } from '../../api/client.js';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';

export default function OpsCommandConfirmCard({
  confirmation,
}: {
  confirmation: NonNullable<ChatEvent['opsConfirmation']>;
}) {
  const [status, setStatus] = useState(confirmation.status ?? 'pending');
  const [output, setOutput] = useState(confirmation.output ?? '');
  const [error, setError] = useState(confirmation.error ?? '');
  const [busy, setBusy] = useState(false);

  const execute = async () => {
    setBusy(true);
    try {
      const { data, error: apiError } = await apiClient.post<{
        result?: { observation?: string };
        confirmation?: { status?: typeof status };
      }>(`/ops-command-confirmations/${encodeURIComponent(confirmation.id)}/execute`, {});
      if (apiError) throw new Error(apiError.message);
      setStatus(data?.confirmation?.status ?? 'executed');
      setOutput(data?.result?.observation ?? '');
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
      if (apiError) throw new Error(apiError.message);
      setStatus('rejected');
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
