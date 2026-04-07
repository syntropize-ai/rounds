import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { slideIn } from '../animations.js';
import type { ChatEvent } from '../hooks/useDashboardChat.js';

// Types

interface Props {
  events: ChatEvent[];
  isGenerating: boolean;
  onSendMessage: (content: string) => void;
  onStop?: () => void;
}

// Block grouping

interface MessageBlock {
  type: 'message';
  event: ChatEvent;
}
interface AgentBlock {
  type: 'agent';
  events: ChatEvent[];
  id: string;
}
type Block = MessageBlock | AgentBlock;

function groupEvents(events: ChatEvent[]): Block[] {
  const blocks: Block[] = [];
  let currentAgent: ChatEvent[] = [];

  const flushAgent = () => {
    if (currentAgent.length > 0) {
      blocks.push({ type: 'agent', events: [...currentAgent], id: currentAgent[0]!.id });
      currentAgent = [];
    }
  };

  for (const evt of events) {
    if (evt.kind === 'message' || evt.kind === 'error') {
      flushAgent();
      blocks.push({ type: 'message', event: evt });
    } else if (evt.kind === 'done') {
      flushAgent();
    } else {
      currentAgent.push(evt);
    }
  }

  flushAgent();
  return blocks;
}

// Step processing

// Phase-grouped step builder.
// Multiple tool events that belong to the same phase merge into one step
// with in-place status updates instead of adding new rows.

interface StepRow {
  id: string;
  phase: string;
  label: string;
  status: string;
  result?: { text: string; success: boolean };
  done: boolean;
  subStepCount: number;
}

/**
 * Derive a phase key from a tool name.
 * Tools sharing a phase merge into one step row.
 * Convention: tool names with common prefix group together.
 */
function phaseOf(tool: string): string {
  // Underscore-delimited prefix grouping
  // discover_metrics, discover_labels, sample_metrics → discover
  // investigate_plan, investigate_query, investigate_analyze → investigate
  // generate_group, generate_panels → generate
  // panel_adder_generate, panel_adder_critic → panel_adder
  // web_search → research (special case since research agent calls it)
  if (tool === 'web_search') return 'research';
  if (tool === 'sample_metrics') return 'discover';
  if (tool === 'validate_query' || tool === 'fix_query') return 'generate';
  if (tool === 'critic' || tool === 'build_progress') return 'generate';

  const parts = tool.split('_');
  return parts.length > 1 ? parts.slice(0, -1).join('_') : tool;
}

function buildSteps(events: ChatEvent[]): { steps: StepRow[]; preStatus: string | null } {
  const steps: StepRow[] = [];
  const phaseMap = new Map<string, StepRow>();
  let preStatus: string | null = null;

  for (const evt of events) {
    if (evt.kind === 'thinking') {
      const active = [...steps].reverse().find((s) => !s.done);
      if (active) {
        active.status = evt.content ?? active.status;
      } else {
        preStatus = evt.content ?? null;
      }
      continue;
    }

    if (evt.kind === 'tool_call') {
      const tool = evt.tool ?? 'unknown';
      const phase = phaseOf(tool);
      const displayText = evt.content ?? TOOL_LABELS[tool] ?? tool;

      const existing = phaseMap.get(phase);
      if (existing && !existing.done) {
        // In-place update: same phase, just update status
        existing.status = displayText;
        existing.subStepCount++;
      } else {
        // New phase → new step row
        const step: StepRow = {
          id: evt.id,
          phase,
          label: displayText,
          status: displayText,
          done: false,
          subStepCount: 1,
        };
        steps.push(step);
        phaseMap.set(phase, step);
      }
      continue;
    }

    if (evt.kind === 'tool_result') {
      const tool = evt.tool ?? 'unknown';
      const phase = phaseOf(tool);
      const match = phaseMap.get(phase);
      if (match) {
        match.status = evt.content ?? match.status;
        // Phase is done when a "summary" result arrives (not intermediate progress)
        // Mark done if the result's tool matches the phase directly
        if (tool === phase || match.subStepCount <= 1) {
          match.result = { text: evt.content ?? '', success: evt.success !== false };
          match.done = true;
        }
      }
      continue;
    }
  }

  return { steps, preStatus };
}

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

function AnimatedDots() {
  return (
    <span className="inline-flex gap-0.5 ml-0.5 translate-y-[-1px]">
      <span className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
      <span className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
      <span className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

const TOOL_LABELS: Record<string, string> = {
  research: 'Research',
  discover: 'Discovery',
  planner: 'Planning',
  building: 'Building',
  generate_dashboard: 'Generating',
  add_panels: 'Adding panels',
  remove_panels: 'Removing',
  modify_panel: 'Modifying',
  rearrange: 'Rearranging',
  add_variable: 'Adding variable',
  set_title: 'Setting title',
  investigate: 'Investigating',
  investigate_plan: 'Planning investigation',
  investigate_query: 'Querying Prometheus',
  investigate_analyze: 'Analyzing evidence',
};

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
          {isActive && <AnimatedDots />}
        </div>
        <div className="text-[11px] text-on-surface-variant truncate mt-0.5 leading-tight">
          {step.result?.text || step.status}
        </div>
      </div>
    </div>
  );
}

// Collapsible agent activity block

function AgentActivityBlock({
  events,
  isLive,
}: {
  events: ChatEvent[];
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  // Auto-collapse when no longer live
  const wasLive = useRef(isLive);
  useEffect(() => {
    if (wasLive.current && !isLive) {
      setExpanded(false);
    }
    wasLive.current = isLive;
  }, [isLive]);

  const { steps, preStatus } = useMemo(() => buildSteps(events), [events]);

  // Summary for collapsed state
  const doneCount = steps.filter((s) => s.done).length;
  const failCount = steps.filter((s) => s.result && !s.result.success).length;
  const lastActive = [...steps].reverse().find((s) => !s.done);

  const summaryText = isLive
    ? expanded
      ? `${doneCount} of ${steps.length} steps done`
      : lastActive
        ? `${lastActive.label}: ${preStatus ?? 'Working...'}`
        : `${steps.length} steps`
    : `${doneCount} steps completed${failCount > 0 ? `, ${failCount} failed` : ''}`;

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left py-1 group"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ChevronIcon expanded={expanded} />
          {isLive ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
              <span className="text-xs text-on-surface-variant truncate">{summaryText}</span>
              <AnimatedDots />
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-secondary shrink-0" />
              <span className="text-xs text-on-surface-variant truncate">{summaryText}</span>
            </>
          )}
        </div>
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
                  <AnimatedDots />
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

// Message components

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex flex-col items-end gap-2 my-4">
      <div className="max-w-[90%] p-4 text-sm leading-relaxed bg-surface-variant rounded-xl rounded-tr-none text-on-surface">
        {content}
      </div>
      <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">You</span>
    </div>
  );
}

function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const bold = rest.match(/\*\*(.+?)\*\*/);
    const code = rest.match(/`(.+?)`/);
    const bits = [bold ? { t: 'b', m: bold, i: bold.index! } : null, code ? { t: 'c', m: code, i: code.index! } : null]
      .filter(Boolean)
      .sort((a, b) => a!.i - b!.i);
    if (bits.length === 0) {
      parts.push(rest);
      break;
    }
    const hit = bits[0]!;
    if (hit.i > 0) parts.push(rest.slice(0, hit.i));
    if (hit.t === 'b') {
      parts.push(
        <strong key={i++} className="font-semibold text-on-surface">
          {hit.m![1]}
        </strong>
      );
    } else {
      parts.push(
        <code key={i++} className="text-[11px] bg-surface-high text-primary px-1 py-0.5 rounded font-mono">
          {hit.m![1]}
        </code>
      );
    }
    rest = rest.slice(hit.i + hit.m![0].length);
  }
  return <>{parts}</>;
}

function AssistantMessage({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="flex flex-col items-start gap-3 my-4">
      <div className="max-w-[95%] p-5 rounded-xl rounded-tl-none bg-surface-high border-l-2 border-tertiary/40 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-tertiary/20 to-transparent" />
        <div className="text-sm leading-relaxed text-on-surface">
          {lines.map((line, i) => {
            if (line.startsWith('## ')) {
              return (
                <div key={i} className="text-sm font-semibold text-on-surface mt-3 mb-1">
                  {line.slice(3)}
                </div>
              );
            }
            if (line.startsWith('- ')) {
              return (
                <div key={i} className="pl-4 relative">
                  <span className="absolute left-0 text-tertiary">•</span>
                  <InlineMd text={line.slice(2)} />
                </div>
              );
            }
            return (
              <div key={i} className={i === 0 ? '' : 'mt-1'}>
                <InlineMd text={line} />
              </div>
            );
          })}
        </div>
      </div>
      <span className="text-[10px] text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
        <svg className="w-3 h-3 text-tertiary" fill="currentColor" viewBox="0 0 20 20">
          <path d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" />
        </svg>
        Prism
      </span>
    </div>
  );
}

function ErrorMessage({ content }: { content: string }) {
  return (
    <div className="my-2">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/25">
        <svg className="w-3.5 h-3.5 text-error shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-7.5 13A1 1 0 003.66 18h16.68a1 1 0 00.87-1.5l-7.5-13a1 1 0 00-1.74 0z" />
        </svg>
        <span className="text-xs text-error">{content}</span>
      </div>
    </div>
  );
}

// Main component

export default function ChatPanel({ events, isGenerating, onSendMessage, onStop }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [input, setInput] = useState('');
  const [unread, setUnread] = useState(0);
  const [chatWidth, setChatWidth] = useState(380);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevEventCountRef = useRef(events.length);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const blocks = useMemo(() => groupEvents(events), [events]);
  const lastAgentBlockId = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i]!.type === 'agent') return (blocks[i] as AgentBlock).id;
    }
    return null;
  }, [blocks]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  useEffect(() => {
    if (collapsed && events.length > prevEventCountRef.current) {
      setUnread((prev) => prev + (events.length - prevEventCountRef.current));
    }
    prevEventCountRef.current = events.length;
  }, [events.length, collapsed]);

  const handleOpen = () => {
    setCollapsed(false);
    setUnread(0);
  };

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: chatWidth };
  }, [chatWidth]);

  const handleDragMove = (e: MouseEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - e.clientX;
    const newWidth = Math.min(700, Math.max(280, dragRef.current.startWidth + delta));
    setChatWidth(newWidth);
  };

  const handleDragEnd = () => {
    dragRef.current = null;
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  };

  useEffect(() => {
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [chatWidth]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isGenerating) return;
    onSendMessage(trimmed);
    setInput('');
  }, [input, isGenerating, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // Collapsed floating bubble
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="h-12 w-12 rounded-full bg-primary hover:bg-primary-container text-white shadow-lg shadow-primary/30 flex items-center justify-center relative transition-all duration-200 shrink-0 self-end m-3"
      >
        <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M18 10c0 3.866-3.582 7-8 7a8.84 8.84 0 01-3.641-.737L2 17l1.026-3.077A6.71 6.71 0 012 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <motion.div
      variants={slideIn}
      initial="hidden"
      animate="visible"
      className="shrink-0 flex flex-col bg-surface-low border-l border-white/5 h-full relative"
      style={{ width: chatWidth }}
    >
      <div
        onMouseDown={handleDragStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 transition-colors -ml-px"
      />

      <div className="flex items-center justify-between px-4 py-4 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-tertiary to-tertiary/60 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" />
            </svg>
          </div>
          <div>
            <p className="text-xs font-bold text-tertiary uppercase tracking-tight">Prism</p>
            <p className="text-[10px] text-on-surface-variant">
              {isGenerating ? 'Working...' : 'Ready'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 hide-scrollbar">
        {events.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center h-full">
            <div className="w-10 h-10 rounded-xl bg-tertiary/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5M7 4h10a3 3 0 013 3v7a3 3 0 01-3 3h-4l-4 3v-3H7a3 3 0 01-3-3V7a3 3 0 013-3z" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-on-surface">Ask a question or request changes to your dashboard.</p>
              <p className="text-xs text-on-surface-variant mt-1">Try: "Add a CPU usage panel" or "Investigate high error rates"</p>
            </div>
          </div>
        )}

        {blocks.map((block) => {
          if (block.type === 'message') {
            const evt = block.event;
            if (evt.kind === 'error') {
              return <ErrorMessage key={evt.id} content={evt.content ?? 'An error occurred'} />;
            }
            if (evt.message?.role === 'user') {
              return <UserMessage key={evt.id} content={evt.message.content} />;
            }
            if (evt.message?.role === 'assistant') {
              return <AssistantMessage key={evt.id} content={evt.message.content} />;
            }
            return null;
          }

          if (block.type === 'agent') {
            return (
              <AgentActivityBlock
                key={block.id}
                events={block.events}
                isLive={isGenerating && block.id === lastAgentBlockId}
              />
            );
          }

          return null;
        })}

        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-4 py-4 bg-surface-low border-t border-white/5 space-y-4">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI to investigate..."
            rows={1}
            disabled={isGenerating}
            className="w-full bg-surface-bright ring-1 ring-white/5 focus:ring-tertiary/50 rounded-xl py-4 pl-5 pr-14 text-sm text-on-surface placeholder-on-surface-variant outline-none resize-none transition-all disabled:opacity-50"
            style={{ minHeight: '52px', maxHeight: '120px' }}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
          />
          {isGenerating && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="absolute right-12 bottom-3 w-8 h-8 rounded-lg bg-surface-highest hover:bg-error/20 text-on-surface-variant hover:text-error flex items-center justify-center transition-colors"
              title="Stop"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <rect x="5" y="5" width="10" height="10" rx="1" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim()}
            className="absolute right-3 bottom-3 w-8 h-8 bg-tertiary rounded-lg flex items-center justify-center text-white shadow-lg shadow-tertiary/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-30"
            title="Send"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L12.586 11H3a1 1 0 110-2h9.586l-3.293-3.293a1 1 0 011.414-1.414l4 4z" clipRule="evenodd" transform="rotate(-90 10 10)" />
            </svg>
          </button>
        </div>
        {!isGenerating && (
          <p className="text-[10px] text-center text-on-surface-variant/50">
            Press <kbd className="px-1.5 py-0.5 bg-surface-highest rounded text-on-surface-variant">Enter</kbd> to send
          </p>
        )}
      </div>
    </motion.div>
  );
}
