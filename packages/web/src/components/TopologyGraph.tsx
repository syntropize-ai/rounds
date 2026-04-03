import React from 'react';
import type { Evidence } from '@agentic-obs/common';

interface EvidenceResult {
  rawData?: unknown;
  summary?: string;
}

interface Props {
  // The root service being investigated
  entity: string;
  // All evidence items - we extract dependency info from inspect_downstream items
  evidence: Evidence[];
}

interface DepNode {
  name: string;
  hasIssue: boolean;
}

function parseDepNodes(evidence: Evidence[]): DepNode[] {
  const depEvidence = evidence.filter((ev) => ev.query === 'inspect_downstream');
  if (!depEvidence.length) return [];

  const result = depEvidence[0]?.result as EvidenceResult | null;
  if (!result) return [];

  const rawData = result.rawData;
  if (!Array.isArray(rawData)) return [];

  const summary = result.summary ?? '';
  const hasIssues = summary.toLowerCase().includes('issue') || summary.toLowerCase().includes('anomal');

  return rawData.map((name) => ({
    name: String(name),
    // Mark as having issue if the summary mentions the dep name and anomaly keywords
    hasIssue: hasIssues && summary.toLowerCase().includes(String(name).toLowerCase()),
  }));
}

interface NodeBoxProps {
  label: string;
  isRoot?: boolean;
  hasIssue?: boolean;
}

function NodeBox({ label, isRoot, hasIssue }: NodeBoxProps) {
  const base = 'rounded-lg border px-3 py-2 text-sm font-medium text-center min-w-24 shadow-sm';
  const style = isRoot
    ? 'bg-slate-800 border-slate-600 text-white'
    : hasIssue
      ? 'bg-red-50 border-red-300 text-red-700'
      : 'bg-white border-slate-200 text-slate-700';

  return (
    <div className={`${base} ${style}`}>
      {hasIssue && <span className="mr-1">!</span>}
      {label}
    </div>
  );
}

export default function TopologyGraph({ entity, evidence }: Props) {
  const deps = parseDepNodes(evidence);
  if (deps.length === 0) return null;

  const anomalousDeps = deps.filter((d) => d.hasIssue);

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Dependency Topology</h3>
        {anomalousDeps.length > 0 && (
          <span className="text-xs font-medium text-red-600">
            {anomalousDeps.length} dependenc{anomalousDeps.length === 1 ? 'y' : 'ies'} with issues
          </span>
        )}
      </div>

      <div className="flex flex-col items-center gap-2">
        <NodeBox label={entity} isRoot />

        <div className="flex flex-col items-center">
          <div className="w-px h-4 bg-slate-300" />
          <div className="text-xs text-slate-400">calls</div>
          <div className="w-px h-4 bg-slate-300" />
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {deps.map((dep) => (
            <NodeBox key={dep.name} label={dep.name} hasIssue={dep.hasIssue} />
          ))}
        </div>
      </div>

      {deps.length > 0 && (
        <p className="text-xs text-slate-400 mt-3 text-center">
          {anomalousDeps.length === 0
            ? `All ${deps.length} downstream service${deps.length === 1 ? '' : 's'} appear healthy`
            : `Issues detected in: ${anomalousDeps.map((d) => d.name).join(', ')}`}
        </p>
      )}
    </div>
  );
}
