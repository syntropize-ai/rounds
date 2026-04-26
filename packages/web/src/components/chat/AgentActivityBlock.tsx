import React, { useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';
import { buildSteps } from './event-processing.js';
import type { StepRow } from './event-processing.js';

// Icons

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-on-surface-variant transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

// Step row component

function StepRowView({
  step,
  isActive,
}: {
  step: StepRow;
  isActive: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5 py-1.5 min-h-[20px]">
      <div className="w-4 shrink-0">
        {isActive ? (
          <span className="block w-2 h-2 rounded-full bg-primary animate-pulse" />
        ) : step.result?.success ? (
          <svg className="w-3.5 h-3.5 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : step.done ? (
          <svg className="w-3.5 h-3.5 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <span className="block w-2 h-2 rounded-full bg-on-surface-variant" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-on-surface">{step.label}</span>
        </div>
        <div className="text-[11px] text-on-surface-variant truncate mt-0.5 leading-tight">
          {step.result?.text || step.status}
        </div>
      </div>
    </div>
  );
}

// Collapsible agent activity block

export default function AgentActivityBlock({
  events,
  isLive,
}: {
  events: ChatEvent[];
  isLive: boolean;
}) {
  // While the agent is running, auto-expand so the user sees live progress.
  // After completion, collapse to keep the chat compact — tool details are
  // still one click away. Reflects whether user manually toggled either way:
  // once the user clicks the chevron, we stop forcing the auto behavior so
  // their preference is honored for the remainder of the session.
  const [expanded, setExpanded] = useState(isLive);
  const userToggledRef = useRef(false);
  const wasLive = useRef(isLive);
  useEffect(() => {
    if (wasLive.current !== isLive) {
      if (!userToggledRef.current) {
        setExpanded(isLive);
      }
      wasLive.current = isLive;
    }
  }, [isLive]);
  const handleToggle = () => {
    userToggledRef.current = true;
    setExpanded((v) => !v);
  };

  const { steps, preStatus } = useMemo(() => buildSteps(events), [events]);

  // Summary for collapsed state
  const doneCount = steps.filter((s) => s.done).length;
  const failCount = steps.filter((s) => s.result && !s.result.success).length;
  const lastActive = [...steps].reverse().find((s) => !s.done);

  // When the only events so far are model thinking (no tool calls yet),
  // surface "Thinking" instead of "Working" / "0 steps" so the user knows
  // the model is reasoning rather than stalled.
  const onlyThinking = steps.length === 0 && Boolean(preStatus);
  const summaryText = isLive
    ? lastActive
      ? lastActive.label
      : onlyThinking
        ? 'Thinking'
        : 'Working'
    : onlyThinking
      ? 'Thinking'
      : `${doneCount} step${doneCount === 1 ? '' : 's'}${failCount > 0 ? ` (${failCount} failed)` : ''}`;

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-2 text-left py-1 px-2 -mx-2 rounded hover:bg-surface-high/50 transition-colors group"
      >
        <ChevronIcon expanded={expanded} />
        {isLive ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            <span className="text-xs text-on-surface-variant truncate">{summaryText}</span>
          </>
        ) : (
          <>
            <svg className="w-3 h-3 text-on-surface-variant/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-xs text-on-surface-variant/70 truncate">{summaryText}</span>
          </>
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="mt-1 px-3 pb-2 border-l border-outline-variant">
              {preStatus && steps.length === 0 && (
                <div className="flex items-center gap-2 py-1.5">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                  <span className="text-xs text-on-surface-variant">{preStatus}</span>
                </div>
              )}
              {steps.map((step) => {
                const isActive = isLive && !step.done && step === [...steps].reverse().find((s) => !s.done);
                return <StepRowView key={step.id} step={step} isActive={isActive} />;
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
