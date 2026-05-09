import React from 'react';
import type { Provenance } from '@agentic-obs/common';

interface Props {
  provenance: Provenance;
  /** Optional click target for the "View run log" link. When omitted the
   *  link is hidden — the header has no opinion on where the log lives. */
  onViewRunLog?: () => void;
}

/**
 * Compact header strip shown above AI-generated artifacts (Task 10).
 *
 * Renders the provenance fields the agent recorded — model, runId, tool-call
 * count, evidence count, cost, latency — and a right-side "View run log"
 * link when the caller wires `onViewRunLog`. Every field is optional; we
 * fall through to "—" rather than crashing because the data flows through
 * a network round trip and may be partial (older rows pre-date Task 10).
 */
export default function ProvenanceHeader({ provenance, onViewRunLog }: Props) {
  const cost = formatCost(provenance.costUsd);
  const latency = formatLatency(provenance.latencyMs);
  const toolCalls = provenance.toolCalls;
  const evidence = provenance.evidenceCount;
  return (
    <div
      data-testid="provenance-header"
      className="flex items-center justify-between gap-4 px-4 py-2 rounded-xl bg-surface-high text-xs text-on-surface-variant"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Field label="Model" value={provenance.model ?? '—'} />
        <Field label="Run" value={shortenRunId(provenance.runId)} mono />
        <Field
          label="Tools"
          value={toolCalls === undefined ? '—' : String(toolCalls)}
        />
        <Field
          label="Evidence"
          value={evidence === undefined ? '—' : String(evidence)}
        />
        <Field label="Cost" value={cost} />
        <Field label="Latency" value={latency} />
      </div>
      {onViewRunLog && (
        <button
          type="button"
          onClick={onViewRunLog}
          className="text-primary hover:underline shrink-0"
        >
          View run log
        </button>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="uppercase tracking-wider text-[10px] text-on-surface-variant/70">
        {label}
      </span>
      <span className={mono ? 'font-mono text-on-surface' : 'text-on-surface'}>
        {value}
      </span>
    </span>
  );
}

export function formatCost(costUsd: number | null | undefined): string {
  if (costUsd === undefined || costUsd === null || Number.isNaN(costUsd)) return '—';
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

export function formatLatency(latencyMs: number | null | undefined): string {
  if (latencyMs === undefined || latencyMs === null || Number.isNaN(latencyMs)) return '—';
  if (latencyMs < 1000) return `${Math.round(latencyMs)}ms`;
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

export function shortenRunId(runId: string | undefined): string {
  if (!runId) return '—';
  return runId.length <= 12 ? runId : `${runId.slice(0, 8)}…`;
}
