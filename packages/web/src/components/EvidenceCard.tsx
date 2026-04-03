import React from 'react';
import type { Evidence } from '@agentic-obs/common';

const TYPE_META: Record<Evidence['type'], { icon: string; color: string; label: string }> = {
  metric: { icon: 'o', color: 'text-blue-400 bg-blue-500/20 border-blue-500/30', label: 'Metric' },
  log: { icon: '!', color: 'text-purple-400 bg-purple-500/20 border-purple-500/30', label: 'Log' },
  trace: { icon: '|', color: 'text-[#8888AA] bg-[#1C1C2E] border-[#2A2A3E]', label: 'Trace' },
  event: { icon: '!', color: 'text-purple-400 bg-purple-500/20 border-purple-500/30', label: 'Event' },
  change: { icon: '~', color: 'text-amber-400 bg-orange-500/20 border-orange-500/30', label: 'Change' },
  log_cluster: { icon: '#', color: 'text-teal-400 bg-teal-500/20 border-teal-500/30', label: 'Log Cluster' },
  trace_waterfall: { icon: 'T', color: 'text-violet-400 bg-violet-500/20 border-violet-500/30', label: 'Trace Waterfall' },
};

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface Props {
  evidence: Evidence;
}

export default function EvidenceCard({ evidence }: Props) {
  const meta = TYPE_META[evidence.type];

  return (
    <div className="bg-[#141420] rounded-lg border border-[#2A2A3E] p-4 space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${meta!.color}`}>
          <span>{meta!.icon}</span>
          <span>{meta!.label}</span>
        </span>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#E8E8ED]">
            {evidence.reproducible ? 'Query can be rerun' : 'Not reproducible'}
          </span>
          {evidence.reproducible ? (
            <span className="text-xs text-green-400">Rerun reproducible</span>
          ) : (
            <span className="text-xs text-[#8888AA]">Not reproducible</span>
          )}
        </div>
        <span className="text-xs text-[#8888AA]">{formatTs(evidence.timestamp)}</span>
      </div>

      <p className="text-sm text-[#E8E8ED] leading-relaxed">{evidence.summary}</p>

      <div className="rounded-md overflow-hidden border border-slate-700">
        <div className="bg-slate-900 px-3 py-1.5 flex items-center justify-between">
          <span className="text-xs text-slate-400 font-mono uppercase tracking-wide">
            {evidence.queryLanguage}
          </span>
        </div>
        <pre className="bg-slate-900 px-3 py-2 text-xs text-emerald-400 font-mono whitespace-pre-wrap break-all overflow-x-auto">
          {evidence.query}
        </pre>
      </div>
    </div>
  );
}
