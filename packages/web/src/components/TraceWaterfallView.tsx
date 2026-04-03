import React, { useState } from 'react';
import type { Evidence } from '@agentic-obs/common';

interface TraceRow {
  traceId?: string;
  totalDurationMs?: number;
  status?: string;
  rootService?: string;
  rootOperation?: string;
  spans?: Array<{
    spanId?: string;
    service?: string;
    operation?: string;
    durationMs?: number;
    status?: string;
    parentSpanId?: string;
  }>;
}

interface EvidenceResult {
  rawData?: unknown;
}

function isEvidenceResult(r: unknown): r is EvidenceResult {
  return typeof r === 'object' && r !== null;
}

function isTraceArray(d: unknown): d is TraceRow[] {
  return Array.isArray(d);
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  error: 'bg-red-100 text-red-700 border-red-200',
  warn: 'bg-slate-100 text-slate-500 border-slate-200',
};

function statusColor(s?: string): string {
  return STATUS_COLOR[s ?? 'unset'] ?? STATUS_COLOR.warn!;
}

function DurationBar({ durationMs, maxMs }: { durationMs: number; maxMs: number }) {
  const pct = maxMs > 0 ? Math.round((durationMs / maxMs) * 100) : 0;
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-violet-400" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-slate-600 w-16 text-right shrink-0">{durationMs.toFixed(0)} ms</span>
    </div>
  );
}

function TraceDetail({ trace, maxMs }: { trace: TraceRow; maxMs: number }) {
  const spans = trace.spans ?? [];
  if (!spans.length) {
    return <p className="text-xs text-slate-400 py-2 pl-4">No span detail available.</p>;
  }

  const spanMax = Math.max(...spans.map((s) => s.durationMs ?? 0), 1);

  return (
    <div className="pl-4 pt-2 pb-3 space-y-1">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
        Spans ({spans.length})
      </p>
      {spans.map((span, i) => (
        <div key={span.spanId ?? i} className="flex items-center gap-2">
          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium shrink-0 ${statusColor(span.status)}`}>
            {span.status ?? 'unset'}
          </span>
          <span className="text-xs text-slate-700 w-36 truncate shrink-0">
            {span.service ?? '?'} / {span.operation ?? '?'}
          </span>
          <DurationBar durationMs={span.durationMs ?? 0} maxMs={Math.max(spanMax, maxMs)} />
        </div>
      ))}
    </div>
  );
}

interface Props {
  evidence: Evidence;
}

export default function TraceWaterfallView({ evidence }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!isEvidenceResult(evidence.result)) return null;
  const rawData = evidence.result.rawData;
  if (!isTraceArray(rawData) || rawData.length === 0) return null;

  const maxMs = Math.max(...rawData.map((t) => t.totalDurationMs ?? 0), 1);
  const hasErrors = rawData.some((t) => t.status === 'error');

  return (
    <div className="mt-2 rounded-md border border-violet-200 overflow-hidden">
      <div className="bg-violet-50 px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-violet-700">
          Trace Waterfall ({rawData.length} trace{rawData.length === 1 ? '' : 's'})
        </span>
        {hasErrors && <span className="text-xs font-medium text-red-600">Error traces detected</span>}
      </div>

      <div className="divide-y divide-slate-100">
        {rawData.map((trace, i) => {
          const tid = trace.traceId ?? `trace-${i}`;
          const isExpanded = expandedId === tid;
          return (
            <div key={tid}>
              <button
                className="w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : tid)}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded border font-medium shrink-0 ${statusColor(trace.status)}`}>
                    {trace.status ?? 'unset'}
                  </span>
                  <span className="text-xs font-mono text-slate-500 w-24 truncate shrink-0">
                    {(trace.traceId ?? '').slice(0, 8)}
                  </span>
                  {trace.rootService || trace.rootOperation ? (
                    <span className="text-xs text-slate-600 w-32 truncate shrink-0">
                      {trace.rootService ?? ''} {trace.rootOperation ? `/${trace.rootOperation}` : ''}
                    </span>
                  ) : null}
                  <DurationBar durationMs={trace.totalDurationMs ?? 0} maxMs={maxMs} />
                  <span className="text-slate-400 text-xs shrink-0">{isExpanded ? '▾' : '▸'}</span>
                </div>
              </button>

              {isExpanded && <TraceDetail trace={trace} maxMs={maxMs} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
