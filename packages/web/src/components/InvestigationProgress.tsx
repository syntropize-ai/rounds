import React from 'react';
import type { InvestigationStatus } from '../api/types.js';

const STEPS: { key: InvestigationStatus; label: string }[] = [
  { key: 'planning', label: 'Planning' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'evidencing', label: 'Evidencing' },
  { key: 'explaining', label: 'Explaining' },
  { key: 'completed', label: 'Done' },
];

const STATUS_ORDER: InvestigationStatus[] = [
  'planning',
  'investigating',
  'evidencing',
  'explaining',
  'acting',
  'verifying',
  'completed',
];

function stepIndex(status: InvestigationStatus): number {
  // Map acting/verifying -> completed position for simplified display
  if (status === 'acting' || status === 'verifying') return 4;
  return STATUS_ORDER.indexOf(status);
}

interface Props {
  status: InvestigationStatus;
}

export default function InvestigationProgress({ status }: Props) {
  const currentIdx = stepIndex(status);
  const isFailed = status === 'failed';

  if (isFailed) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-red-900/20 rounded-xl border border-red-500/30">
        <div className="text-red-400 text-sm font-medium">Investigation failed</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-0">
        {STEPS.map((step, idx) => {
          const done = idx < currentIdx;
          const active = idx === currentIdx;
          const pending = idx > currentIdx;

          return (
            <React.Fragment key={step.key}>
              <div className="flex flex-col items-center">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                    done
                      ? 'bg-indigo-600 text-white'
                      : active
                        ? 'bg-[#6366F1]/20 text-[#6366F1] ring-2 ring-[#6366F1]/40'
                        : 'bg-[#2A2A3E] text-[#8888AA]'
                  }`}
                >
                  {done ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    idx + 1
                  )}
                </div>
                <span
                  className={`mt-1 text-xs ${
                    active ? 'text-[#6366F1] font-medium' : pending ? 'text-[#8888AA]' : 'text-[#E8E8ED]'
                  }`}
                >
                  {step.label}
                </span>
              </div>

              {idx < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-4 transition-colors ${
                    idx < currentIdx ? 'bg-indigo-600' : 'bg-[#2A2A3E]'
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {status !== 'completed' && (
        <p className="text-xs text-[#8888AA] text-center animate-pulse">
          {status === 'planning' && 'Parsing your question...'}
          {status === 'investigating' && 'Gathering context...'}
          {status === 'evidencing' && 'Binding evidence to hypotheses...'}
          {status === 'explaining' && 'Generating conclusion...'}
          {(status === 'acting' || status === 'verifying') && 'Finishing...'}
        </p>
      )}
    </div>
  );
}
