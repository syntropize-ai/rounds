import React, { useState } from 'react';
import type { Hypothesis, Evidence } from '@agentic-obs/common';
import EvidenceCard from './EvidenceCard.js';
import MetricChart from './MetricChart.js';
import TraceWaterfallView from './TraceWaterfallView.js';
import LogClusterView from './LogClusterView.js';

const STATUS_BADGE: Record<Hypothesis['status'], string> = {
  supported: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  refuted: 'bg-red-100 text-red-600 border-red-200',
  investigating: 'bg-amber-100 text-amber-700 border-amber-200',
  proposed: 'bg-slate-100 text-slate-600 border-slate-200',
  inconclusive: 'bg-slate-100 text-slate-500 border-slate-200',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct > 70 ? 'bg-emerald-500' : pct > 40 ? 'bg-amber-400' : 'bg-slate-300';

  return (
    <div className="flex items-center gap-2 mt-1.5">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500 tabular-nums">{pct}%</span>
    </div>
  );
}

interface EvidenceGroupProps {
  label: string;
  items: Evidence[];
  borderColor: string;
  labelColor: string;
  icon: string;
}

function EvidenceGroup({ label, items, borderColor, labelColor, icon }: EvidenceGroupProps) {
  if (!items.length) return null;

  return (
    <div>
      <h4 className={`text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-1 ${labelColor}`}>
        <span>{icon}</span>
        <span>{label}</span>
        <span>({items.length})</span>
      </h4>
      <div className={`space-y-3 p-3 border-l-2 ${borderColor}`}>
        {items.map((ev) => (
          <div key={ev.id}>
            <EvidenceCard evidence={ev} />
            {ev.type === 'metric' && <MetricChart evidence={ev} />}
            {ev.type === 'trace_waterfall' && <TraceWaterfallView evidence={ev} />}
            {ev.type === 'log_cluster' && <LogClusterView evidence={ev} />}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  hypothesis: Hypothesis;
  supportEvidence: Evidence[];
  counterEvidence: Evidence[];
}

export default function HypothesisEvidence({ hypothesis, supportEvidence, counterEvidence }: Props) {
  const [expanded, setExpanded] = useState(false);
  const total = supportEvidence.length + counterEvidence.length;

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      <button
        className="w-full text-left p-4 bg-white hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900 leading-snug">{hypothesis.description}</p>
            <ConfidenceBar value={hypothesis.confidence} />
            {hypothesis.confidenceBasis && (
              <p className="text-xs text-slate-500 mt-1 truncate">{hypothesis.confidenceBasis}</p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`inline-flex text-xs px-2 py-0.5 rounded-full border font-medium ${STATUS_BADGE[hypothesis.status]}`}>
              {hypothesis.status}
            </span>
            <span className="text-xs text-slate-500">{total} evidence</span>
            <span className="text-slate-400 text-xs select-none">{expanded ? '▾' : '▸'}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 bg-slate-50 p-4 space-y-5">
          <EvidenceGroup
            label="Supporting Evidence"
            items={supportEvidence}
            borderColor="border-emerald-300"
            labelColor="text-emerald-700"
            icon="+"
          />
          <EvidenceGroup
            label="Counter Evidence"
            items={counterEvidence}
            borderColor="border-red-300"
            labelColor="text-red-600"
            icon="-"
          />
          {total === 0 && (
            <p className="text-sm text-slate-400 text-center py-6">No evidence collected yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
