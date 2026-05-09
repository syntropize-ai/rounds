import React, { useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';
import { buildSteps, buildToolCalls } from './event-processing.js';
import type { ToolCallCard } from './event-processing.js';

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

function StatusIcon({ status }: { status: ToolCallCard['status'] }) {
  if (status === 'running') {
    return <span className="block w-2 h-2 rounded-full bg-primary animate-pulse" />;
  }
  if (status === 'error') {
    return (
      <svg className="w-3.5 h-3.5 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

const OUTPUT_PREVIEW_CHARS = 200;

/**
 * One expandable card per tool call. Renders tool name + status, sanitized
 * input args, output preview with "Show full" toggle when long, and chips
 * for evidence id / cost / duration when those fields are present on the
 * underlying events.
 */
export function ToolCallCardView({ card }: { card: ToolCallCard }) {
  const [showFullOutput, setShowFullOutput] = useState(false);

  const fullOutput = card.output ?? card.summary ?? '';
  const isLong = fullOutput.length > OUTPUT_PREVIEW_CHARS;
  const displayedOutput =
    isLong && !showFullOutput ? fullOutput.slice(0, OUTPUT_PREVIEW_CHARS) + '…' : fullOutput;

  const paramsText =
    card.params && Object.keys(card.params).length > 0
      ? JSON.stringify(card.params, null, 2)
      : null;

  return (
    <div
      data-tool-call-card
      data-tool={card.tool}
      className="my-1.5 px-2.5 py-2 rounded border border-outline-variant bg-surface-low/40"
    >
      <div className="flex items-center gap-2">
        <div className="w-4 shrink-0 flex items-center justify-center">
          <StatusIcon status={card.status} />
        </div>
        <span className="text-xs font-medium text-on-surface flex-1 truncate">{card.label}</span>
        <span className="text-[10px] font-mono text-on-surface-variant/70 shrink-0">
          {card.tool}
        </span>
        {typeof card.durationMs === 'number' && (
          <span className="text-[10px] text-on-surface-variant shrink-0 tabular-nums">
            {card.durationMs >= 1000
              ? `${(card.durationMs / 1000).toFixed(1)}s`
              : `${card.durationMs}ms`}
          </span>
        )}
      </div>

      {(paramsText || fullOutput || card.evidenceId || typeof card.cost === 'number') && (
        <div className="mt-1.5 ml-6 space-y-1.5">
          {paramsText && (
            <details className="group">
              <summary className="text-[11px] text-on-surface-variant cursor-pointer hover:text-on-surface select-none">
                Input
              </summary>
              <pre
                data-testid="tool-call-params"
                className="mt-1 p-1.5 text-[11px] font-mono text-on-surface-variant whitespace-pre-wrap break-all bg-surface-low rounded"
              >
                {paramsText}
              </pre>
            </details>
          )}

          {fullOutput && (
            <div>
              <pre
                data-testid="tool-call-output"
                className="p-1.5 text-[11px] font-mono text-on-surface-variant whitespace-pre-wrap break-all bg-surface-low rounded"
              >
                {displayedOutput}
              </pre>
              {isLong && (
                <button
                  type="button"
                  data-testid="tool-call-show-full"
                  onClick={() => setShowFullOutput((v) => !v)}
                  className="mt-1 text-[11px] text-primary hover:underline"
                >
                  {showFullOutput ? 'Show less' : 'Show full'}
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 items-center">
            {card.evidenceId && (
              <span
                data-testid="tool-call-evidence"
                className="px-1.5 py-0.5 text-[10px] rounded bg-secondary-container text-on-secondary-container"
                title="Evidence id"
              >
                evidence: {card.evidenceId}
              </span>
            )}
            {typeof card.cost === 'number' && (
              <span
                data-testid="tool-call-cost"
                className="px-1.5 py-0.5 text-[10px] rounded bg-tertiary-container text-on-tertiary-container tabular-nums"
                title="LLM cost"
              >
                ${card.cost.toFixed(4)}
              </span>
            )}
          </div>
        </div>
      )}
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
  const cards = useMemo(() => buildToolCalls(events), [events]);

  // Summary for collapsed state — phase-grouped (steps), so 5 metrics_query
  // events still summarize as one "Querying metrics" phase rather than 5.
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
        aria-expanded={expanded}
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
              {preStatus && cards.length === 0 && (
                <div className="flex items-center gap-2 py-1.5">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                  <span className="text-xs text-on-surface-variant">{preStatus}</span>
                </div>
              )}
              {cards.map((card) => (
                <ToolCallCardView key={card.id} card={card} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
