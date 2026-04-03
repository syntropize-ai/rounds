import React, { useState } from 'react';
import type { Evidence } from '@agentic-obs/common';

interface LogLine {
  timestamp?: string;
  level?: string;
  message?: string;
  service?: string;
}

interface LogCluster {
  id?: string;
  template: string;
  count?: number;
  level?: string;
  sampleLines?: LogLine[];
  firstSeen?: string;
  lastSeen?: string;
}

interface EvidenceResult {
  rawData?: unknown;
}

function isClusters(d: unknown): d is LogCluster[] {
  return Array.isArray(d);
}

const LEVEL_COLOR: Record<string, string> = {
  error: 'bg-red-100 text-red-700 border-red-200',
  fatal: 'bg-red-200 text-red-800 border-red-300',
  warn: 'bg-amber-100 text-amber-700 border-amber-200',
  info: 'bg-blue-100 text-blue-600 border-blue-200',
  debug: 'bg-slate-100 text-slate-500 border-slate-200',
  trace: 'bg-slate-50 text-slate-400 border-slate-100',
};

function levelColor(level?: string): string {
  return LEVEL_COLOR[level ?? 'info'] ?? LEVEL_COLOR.info!;
}

function formatTs(ts?: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}

interface Props {
  evidence: Evidence;
}

export default function LogClusterView({ evidence }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const result = evidence.result as EvidenceResult | null;
  if (!result) return null;
  const rawData = result.rawData;
  if (!isClusters(rawData) || rawData.length === 0) return null;

  // Sort by count descending
  const sorted = [...rawData].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const totalCount = sorted.reduce((c, e) => c + (e.count ?? 0), 0);
  const hasErrors = sorted.some((c) => c.level === 'error' || c.level === 'fatal');

  return (
    <div className="mt-2 rounded-md border border-slate-200 overflow-hidden">
      <div className="bg-teal-50 px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-teal-700">
          Log Clusters ({sorted.length} pattern{sorted.length === 1 ? '' : 's'}, {totalCount.toLocaleString()} times)
        </span>
        {hasErrors && (
          <span className="text-xs font-medium text-red-600">
            Error patterns found
          </span>
        )}
      </div>

      <div className="divide-y divide-slate-100">
        {sorted.map((cluster) => {
          const cid = cluster.id ?? `cluster-${cluster.template}`;
          const isExpanded = expandedId === cid;
          const pct = totalCount > 0 ? Math.round(((cluster.count ?? 0) / totalCount) * 100) : 0;

          return (
            <div key={cid}>
              <button
                className="w-full text-left px-3 py-2.5 hover:bg-slate-50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : cid)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium shrink-0 mt-0.5 ${levelColor(cluster.level)}`}>
                        {cluster.level ?? 'info'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-mono text-slate-700 truncate leading-snug">
                          {cluster.template ?? '(empty template)'}
                        </p>
                        <div className="flex items-center gap-4 mt-1">
                          <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-teal-400" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-slate-500">
                            {(cluster.count ?? 0).toLocaleString()} occurrences ({pct}%)
                          </span>
                          {cluster.firstSeen && (
                            <span className="text-xs text-slate-400">
                              {formatTs(cluster.firstSeen)} - {formatTs(cluster.lastSeen)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <span className="text-slate-400 text-xs shrink-0 mt-1">{isExpanded ? '▾' : '▸'}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="bg-slate-50 px-3 py-2 space-y-1">
                  {cluster.sampleLines?.length === 0 && (
                    <p className="text-xs text-slate-400">No sample lines available.</p>
                  )}
                  {cluster.sampleLines?.map((line, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs font-mono">
                      <span className="text-slate-500 shrink-0 w-16">{formatTs(line.timestamp)}</span>
                      <span className={`shrink-0 ${line.level === 'error' || line.level === 'fatal' ? 'text-red-400' : 'text-slate-400'}`}>
                        [{line.level ?? '?'}]
                      </span>
                      <span className="text-emerald-400 break-all">{line.message ?? ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
