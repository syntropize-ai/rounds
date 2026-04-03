import React from 'react';
import type { Evidence } from '@agentic-obs/common';
import TimeSeriesChart from './TimeSeriesChart.js';

interface MetricResult {
  value: number;
  baseline?: number;
}

function isMetricResult(r: unknown): r is MetricResult {
  return typeof r === 'object' && r !== null && 'value' in r && typeof (r as { value: unknown }).value === 'number';
}

function hasTimeSeries(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'series' in r && Array.isArray((r as { series: unknown }).series);
}

interface Props {
  evidence: Evidence;
}

export default function MetricChart({ evidence }: Props) {
  // Time-series data from Prometheus - render as chart
  if (hasTimeSeries(evidence.result)) {
    return <TimeSeriesChart result={evidence.result} />;
  }

  // Legacy single-value comparison
  if (!isMetricResult(evidence.result)) return null;

  const { value, baseline } = evidence.result;

  if (baseline === undefined || baseline === 0) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-slate-500 w-16 shrink-0">Value</span>
        <div className="text-sm font-mono font-semibold text-slate-800">{value}</div>
      </div>
    );
  }

  const max = Math.max(value, baseline) * 1.25;
  const valuePct = Math.round((value / max) * 100);
  const baselinePct = Math.round((baseline / max) * 100);

  const ratio = baseline > 0 ? value / baseline : 1;
  const barColor =
    ratio > 2 ? 'bg-red-500' :
    ratio > 1.3 ? 'bg-amber-400' :
    ratio < 0.7 ? 'bg-sky-400' :
    'bg-emerald-500';

  const ratioLabel =
    ratio > 1
      ? `${ratio.toFixed(1)}x above baseline`
      : ratio < 1
        ? `${(1 / ratio).toFixed(1)}x below baseline`
        : 'at baseline';

  return (
    <div className="mt-2 space-y-1.5 bg-slate-50 rounded-md p-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500 w-16 shrink-0">Current</span>
        <div className="flex-1 h-4 bg-slate-200 rounded overflow-hidden">
          <div className={`h-full rounded ${barColor} transition-all`} style={{ width: `${valuePct}%` }} />
        </div>
        <span className="text-xs font-mono text-slate-700 w-14 text-right">{value}</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500 w-16 shrink-0">Baseline</span>
        <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
          <div className="h-full rounded bg-slate-400" style={{ width: `${baselinePct}%` }} />
        </div>
        <span className="text-xs font-mono text-slate-700 w-14 text-right">{baseline}</span>
      </div>

      <p className={`text-xs mt-1 ${ratio > 1.3 ? 'text-red-600 font-medium' : 'text-slate-500'}`}>
        {ratioLabel}
      </p>
    </div>
  );
}
