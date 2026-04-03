import React, { useState } from 'react';
import type { IncidentTimelineEntry, IncidentTimelineEntryType } from '@agentic-obs/common';

export interface ActionExecutedData {
  actionType?: string;
  targetService?: string;
  success?: boolean;
  output?: unknown;
  error?: string;
  // DryRun estimated impact before execution
  dryRunEstimatedImpact?: string;
  // DryRun warnings
  dryRunWarnings?: string[];
}

export interface ActionApprovedData {
  approvedBy?: string;
  actionType?: string;
  targetService?: string;
}

export interface ActionRejectedData {
  rejectedBy?: string;
  reason?: string;
  actionType?: string;
  targetService?: string;
}

export interface VerificationResultData {
  outcome?: 'resolved' | 'improved' | 'unchanged' | 'degraded';
  reasoning?: string;
  shouldRollback?: boolean;
  nextSteps?: string[];
  preMetrics?: Record<string, unknown>;
  postMetrics?: Record<string, unknown>;
}

// Pure helpers (exported for testing)
// Returns the Tailwind dot/icon color class for a timeline entry type.
export function getEntryDotColor(type: IncidentTimelineEntryType): string {
  switch (type) {
    case 'action_executed':
      return 'bg-blue-500';
    case 'action_approved':
      return 'bg-green-500';
    case 'action_rejected':
      return 'bg-red-500';
    case 'verification_result':
      return 'bg-purple-500';
    case 'investigation_created':
      return 'bg-indigo-400';
    case 'conclusion_generated':
      return 'bg-indigo-600';
    case 'status_changed':
      return 'bg-amber-400';
    case 'note_added':
      return 'bg-slate-400';
    default:
      return 'bg-slate-300';
  }
}

// Returns the text color class for the entry badge.
export function getEntryTextColor(type: IncidentTimelineEntryType): string {
  switch (type) {
    case 'action_executed':
      return 'text-blue-700 bg-blue-50';
    case 'action_approved':
      return 'text-green-700 bg-green-50';
    case 'action_rejected':
      return 'text-red-700 bg-red-50';
    case 'verification_result':
      return 'text-purple-700 bg-purple-50';
    default:
      return 'text-slate-600 bg-slate-50';
  }
}

// Returns a human-readable label for a timeline entry type.
export function getEntryLabel(type: IncidentTimelineEntryType): string {
  switch (type) {
    case 'action_executed':
      return 'Action Executed';
    case 'action_approved':
      return 'Action Approved';
    case 'action_rejected':
      return 'Action Rejected';
    case 'verification_result':
      return 'Verification';
    case 'investigation_created':
      return 'Investigation';
    case 'conclusion_generated':
      return 'Conclusion';
    case 'status_changed':
      return 'Status Change';
    case 'note_added':
      return 'Note';
    default:
      return type;
  }
}

// Returns true for entry types that have an expandable details section.
export function hasExpandableDetails(type: IncidentTimelineEntryType): boolean {
  return type === 'action_executed' || type === 'verification_result';
}

// Returns the outcome badge color for a verification outcome.
export function getVerificationOutcomeColor(
  outcome: VerificationResultData['outcome'],
): string {
  switch (outcome) {
    case 'resolved':
      return 'text-green-700 bg-green-50';
    case 'improved':
      return 'text-blue-700 bg-blue-50';
    case 'unchanged':
      return 'text-amber-700 bg-amber-50';
    case 'degraded':
      return 'text-red-700 bg-red-50';
    default:
      return 'text-slate-600 bg-slate-50';
  }
}

// Formats an ISO timestamp as human-readable string.
export function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ActionExecutedDetail({ data }: { data: ActionExecutedData }) {
  return (
    <div className="space-y-2 text-sm">
      {data.actionType || data.targetService ? (
        <div className="flex gap-2 flex-wrap">
          {data.actionType && (
            <span className="font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-xs">
              {data.actionType}
            </span>
          )}
          {data.targetService && (
            <span className="text-slate-500 text-xs">{data.targetService}</span>
          )}
        </div>
      ) : null}

      {data.dryRunEstimatedImpact && (
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1.5">Expected impact</p>
          <p className="text-slate-600 text-xs">{data.dryRunEstimatedImpact}</p>
        </div>
      )}

      {data.dryRunWarnings && data.dryRunWarnings.length > 0 && (
        <div>
          <p className="text-xs font-medium text-amber-500 mb-1.5">Dryrun warnings</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.dryRunWarnings.map((w) => (
              <li key={w} className="text-amber-700 text-xs">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-medium text-slate-500 mb-1.5">Actual result</p>
        {data.success === true && (
          <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 px-2 py-0.5 rounded text-xs font-medium">
            Successful
          </span>
        )}
        {data.success === false && (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-red-700 bg-red-50 px-2 py-0.5 rounded text-xs font-medium">
              Failed
            </span>
            {data.error && <p className="text-red-600 text-xs">{data.error}</p>}
          </div>
        )}
        {data.output !== undefined && data.output !== null && (
          <pre className="mt-1 text-xs font-mono bg-slate-50 rounded p-2 overflow-auto max-h-24 text-slate-700">
            {JSON.stringify(data.output, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function VerificationResultDetail({ data }: { data: VerificationResultData }) {
  return (
    <div className="space-y-2 text-sm">
      {data.outcome && (
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${getVerificationOutcomeColor(
              data.outcome,
            )}`}
          >
            {data.outcome}
          </span>
          {data.shouldRollback && (
            <span className="text-red-600 text-xs font-medium">Rollback recommended</span>
          )}
        </div>
      )}

      {data.reasoning && <p className="text-slate-600 text-xs">{data.reasoning}</p>}

      {(data.preMetrics || data.postMetrics) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {data.preMetrics && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">Before</p>
              <pre className="text-xs font-mono bg-slate-50 rounded p-2 overflow-auto max-h-20 text-slate-700">
                {JSON.stringify(data.preMetrics, null, 2)}
              </pre>
            </div>
          )}
          {data.postMetrics && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">After</p>
              <pre className="text-xs font-mono bg-slate-50 rounded p-2 overflow-auto max-h-20 text-slate-700">
                {JSON.stringify(data.postMetrics, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {data.nextSteps && data.nextSteps.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 mb-0.5">Next steps</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.nextSteps.map((step, i) => (
              <li key={i} className="text-slate-600 text-xs">
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActionApprovedDetail({ data }: { data: ActionApprovedData }) {
  return (
    <div className="space-y-1 text-sm">
      {data.approvedBy && (
        <span className="text-green-700 text-xs">
          Approved by: <strong>{data.approvedBy}</strong>
        </span>
      )}
      {data.actionType && (
        <div>
          <span className="font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-xs">
            {data.actionType}
          </span>
        </div>
      )}
    </div>
  );
}

function ActionRejectedDetail({ data }: { data: ActionRejectedData }) {
  return (
    <div className="space-y-1 text-sm">
      {data.rejectedBy && (
        <span className="text-red-700 text-xs">
          Rejected by: <strong>{data.rejectedBy}</strong>
        </span>
      )}
      {data.reason && <p className="text-red-600 text-xs">{data.reason}</p>}
    </div>
  );
}

interface TimelineEntryProps {
  entry: IncidentTimelineEntry;
  isLast: boolean;
}

function TimelineEntry({ entry, isLast }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = hasExpandableDetails(entry.type);
  const data = (entry.data ?? {}) as Record<string, unknown>;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`mt-1 h-2.5 w-2.5 rounded-full shrink-0 ${getEntryDotColor(entry.type)}`}
          aria-hidden="true"
        />
        {!isLast && <div className="px flex-1 bg-slate-200 mt-1 w-px" />}
      </div>

      <div className={`flex-1 pb-4 ${isLast ? '' : ''}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${getEntryTextColor(entry.type)}`}>
              {getEntryLabel(entry.type)}
            </span>
            <span className="text-xs text-slate-400">{entry.actorId}</span>
            <span className="hidden text-xs text-slate-400 whitespace-nowrap md:inline">
              {formatTimestamp(entry.timestamp)}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-2 shrink-0">
            <span className="text-xs text-slate-400 whitespace-nowrap">
              {formatTimestamp(entry.timestamp)}
            </span>
            {canExpand && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
                className="pl-1 text-slate-400 hover:text-slate-600 text-xs"
              >
                {expanded ? '▴' : '▾'}
              </button>
            )}
          </div>
        </div>

        <p className="text-sm text-slate-700">{entry.description}</p>

        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="sm:hidden py-1 -ml-1 text-slate-400 hover:text-slate-600 text-xs"
          >
            {expanded ? '▴' : '▾'}
          </button>
        )}

        {entry.type === 'action_approved' && Object.keys(data).length > 0 && (
          <div className="mt-2 p-3 rounded-lg border border-blue-100 bg-blue-50/40">
            <ActionApprovedDetail data={data as ActionApprovedData} />
          </div>
        )}

        {entry.type === 'action_rejected' && Object.keys(data).length > 0 && (
          <div className="mt-2 p-3 rounded-lg border border-red-100 bg-red-50/40">
            <ActionRejectedDetail data={data as ActionRejectedData} />
          </div>
        )}

        {expanded && entry.type === 'action_executed' && (
          <div className="mt-2 p-3 rounded-lg border border-blue-100 bg-blue-50/40">
            <ActionExecutedDetail data={data as ActionExecutedData} />
          </div>
        )}

        {expanded && entry.type === 'verification_result' && (
          <div className="mt-2 p-3 rounded-lg border border-purple-100 bg-purple-50/40">
            <VerificationResultDetail data={data as VerificationResultData} />
          </div>
        )}
      </div>
    </div>
  );
}

interface IncidentTimelineProps {
  entries: IncidentTimelineEntry[];
}

export default function IncidentTimeline({ entries }: IncidentTimelineProps) {
  if (!entries.length) {
    return (
      <div className="text-center py-6 text-slate-400 text-sm">
        No timeline entries yet.
      </div>
    );
  }

  // Sort by timestamp ascending
  const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return (
    <div className="flow-root">
      {sorted.map((entry, index) => (
        <TimelineEntry
          key={entry.id}
          entry={entry}
          isLast={index === sorted.length - 1}
        />
      ))}
    </div>
  );
}
