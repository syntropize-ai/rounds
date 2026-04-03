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

const TOP_LEVEL_TOOLS = new Set([
  'research',
  'discover',
  'planner',
  'add_panels',
  'remove_panels',
  'modify_panel',
  'rearrange',
  'add_variable',
  'set_title',
  'investigate',
  'investigate_plan',
  'investigate_query',
  'investigate_analyze',
]);

// Tools that are meta-actions (their sub-steps are already shown) - hide from step list
const META_TOOLS = new Set(['generate_dashboard']);

// Tools that get folded into the "Building" step
const BUILD_TOOLS = new Set(['generate_group', 'critic', 'build_progress']);

interface StepRow {
  id: string;
  tool: string;
  label: string;
  status: string;
  result?: { text: string; success: boolean };
  done: boolean;
  // For building step: progress tracking.
  progress?: { completed: number; total: number; currentSection: string };
}

function buildSteps(events: ChatEvent[]): { steps: StepRow[]; preStatus: string | null } {
  const steps: StepRow[] = [];
  const stepsByTool = new Map<string, StepRow>(); // lookup by tool name for out-of-order results
  let preStatus: string | null = null;

  // Track the building step separately - merge all generate/critic events into one row
  let buildStep: StepRow | null = null;
  let planTotal = 0;
  let buildCompleted = 0;

  for (const evt of events) {
    // Skip meta-tools - their sub-steps are shown individually
    if (evt.kind === 'tool_call' && evt.tool && META_TOOLS.has(evt.tool)) {
      continue;
    }

    // Extract total group count from planner result
    if (evt.kind === 'tool_result' && evt.tool === 'planner') {
      const match = evt.content?.match(/(\d+)\s*sections?/i);
      if (match) planTotal = Number.parseInt(match[1]!, 10);
    }

    // Build-related events - merge into single building step
    if ((evt.kind === 'tool_call' || evt.kind === 'tool_result') && BUILD_TOOLS.has(evt.tool ?? '')) {
      if (!buildStep) {
        buildStep = {
          id: `build-${evt.id}`,
          tool: 'building',
          label: 'Building',
          status: 'Starting...',
          done: false,
          progress: { completed: 0, total: planTotal, currentSection: '' },
        };
        steps.push(buildStep);
      }

      if (evt.kind === 'tool_call' && evt.tool === 'generate_group') {
        const sectionMatch = evt.content?.match(/group\s+["']?([^"']+)["']?/i);
        const section = sectionMatch?.[1] ?? '';
        buildStep.status = `Generating ${section}`;
        buildStep.progress = { ...buildStep.progress!, currentSection: section };
      } else if (evt.kind === 'tool_call' && evt.tool === 'critic') {
        const sectionMatch = evt.content?.match(/group\s+["']?([^"']+)["']?/i);
        const section = sectionMatch?.[1] ?? buildStep.progress?.currentSection ?? '';
        buildStep.status = `Reviewing ${section}`;
        buildStep.progress = { ...buildStep.progress!, currentSection: section };
      } else if (evt.kind === 'tool_result' && evt.tool === 'build_progress') {
        const progressMatch = evt.content?.match(/(\d+)\/(\d+)/);
        if (progressMatch) {
          buildCompleted = Number.parseInt(progressMatch[1]!, 10);
          const total = Number.parseInt(progressMatch[2]!, 10);
          buildStep.progress = { ...buildStep.progress!, completed: buildCompleted, total };
          buildStep.status = evt.content ?? buildStep.status;
        }
      } else if (evt.kind === 'tool_result' && evt.tool === 'critic') {
        buildStep.status = evt.content ?? buildStep.status;
      }

      if (buildStep.progress && buildStep.progress.total > 0 && buildCompleted >= buildStep.progress.total) {
        buildStep.done = true;
        buildStep.result = {
          text: `${buildStep.progress.total} sections built`,
          success: true,
        };
      }
      continue;
    }

    // Top-level tool result - find its matching step (supports out-of-order/parallel results)
    if (evt.kind === 'tool_result' && evt.tool && TOP_LEVEL_TOOLS.has(evt.tool)) {
      const matchStep = stepsByTool.get(evt.tool);
      if (matchStep) {
        matchStep.result = { text: evt.content ?? '', success: evt.success ?? false };
        matchStep.status = evt.content ?? matchStep.status;
        matchStep.done = true;
      }
      continue;
    }

    // Top-level tool call - new step row
    if (evt.kind === 'tool_call' && evt.tool && TOP_LEVEL_TOOLS.has(evt.tool)) {
      const step: StepRow = {
        id: evt.id,
        tool: evt.tool,
        label: TOOL_LABELS[evt.tool] ?? evt.tool,
        status: evt.content ?? '',
        done: false,
      };
      steps.push(step);
      stepsByTool.set(evt.tool, step);
      continue;
    }

    // Thinking events - update the last non-done step, or set preStatus
    if (evt.kind === 'thinking') {
      const active = [...steps].reverse().find((s) => !s.done);
      if (active) {
        active.status = evt.content ?? active.status;
      } else if (steps.length === 0) {
        preStatus = evt.content ?? null;
      }
      continue;
    }

    // Minor tool events - update last active step
    if (evt.kind === 'tool_call' && evt.tool && !TOP_LEVEL_TOOLS.has(evt.tool)) {
      const active = [...steps].reverse().find((s) => !s.done);
      if (active) {
        active.status = evt.content ?? active.status;
      }
    }
  }

  return { steps, preStatus };
}

// Icons

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-[#555570] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
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
      <span className="w-1 h-1 rounded-full bg-[#6366F1] animate-bounce [animation-delay:0ms]" />
      <span className="w-1 h-1 rounded-full bg-[#6366F1] animate-bounce [animation-delay:150ms]" />
      <span className="w-1 h-1 rounded-full bg-[#6366F1] animate-bounce [animation-delay:300ms]" />
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
          <span className="block w-2 h-2 rounded-full bg-[#6366F1] animate-pulse" />
        ) : step.result?.success ? (
          <svg className="w-3.5 h-3.5 text-[#34D399]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : step.done ? (
          <svg className="w-3.5 h-3.5 text-[#EF4444]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <span className="block w-2 h-2 rounded-full bg-[#555570]" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-[#E8E8ED]">{step.label}</span>
          {step.progress && step.progress.total > 0 && (
            <span className="text-[10px] font-mono text-[#818CF8] bg-[#6366F1]/10 px-1.5 py-0.5 rounded">
              {step.progress.completed}/{step.progress.total}
            </span>
          )}
          {isActive && <AnimatedDots />}
        </div>
        <div className="text-[11px] text-[#555570] truncate mt-0.5 leading-tight">
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
        ? `${lastActive.label}: ${lastActive.progress?.completed ?? lastActive.progress?.total ? `${lastActive.progress?.completed}/${lastActive.progress?.total}` : ''} ${preStatus ?? 'Working...'}`
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
              <span className="w-1.5 h-1.5 rounded-full bg-[#6366F1] animate-pulse shrink-0" />
              <span className="text-xs text-[#8888AA] truncate">{summaryText}</span>
              <AnimatedDots />
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] shrink-0" />
              <span className="text-xs text-[#555570] truncate">{summaryText}</span>
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
            <div className="mt-1 px-3 pb-2 border-l border-[#2A2A3E]">
              {preStatus && steps.length === 0 && (
                <div className="flex items-center gap-2 py-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#6366F1] animate-pulse shrink-0" />
                  <span className="text-xs text-[#8888AA]">{preStatus}</span>
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
    <div className="flex justify-end my-3">
      <div className="max-w-[85%] px-4 py-2 text-sm leading-relaxed bg-[#6366F1] text-white rounded-2xl rounded-br-md">
        {content}
      </div>
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
        <strong key={i++} className="font-semibold text-[#E8E8ED]">
          {hit.m![1]}
        </strong>
      );
    } else {
      parts.push(
        <code key={i++} className="text-[11px] bg-[#1C1C2E] text-[#818CF8] px-1 py-0.5 rounded font-mono">
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
    <div className="my-3">
      <div className="text-sm leading-relaxed text-[#C8C8D8]">
        {lines.map((line, i) => {
          if (line.startsWith('## ')) {
            return (
              <div key={i} className="text-sm font-semibold text-[#E8E8ED] mt-3 mb-1">
                {line.slice(3)}
              </div>
            );
          }
          if (line.startsWith('- ')) {
            return (
              <div key={i} className="pl-4 relative">
                <span className="absolute left-0 text-[#6366F1]">•</span>
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
  );
}

function ErrorMessage({ content }: { content: string }) {
  return (
    <div className="my-2">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-[#EF4444]/10 border border-[#EF4444]/25">
        <svg className="w-3.5 h-3.5 text-[#EF4444] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-7.5 13A1 1 0 003.66 18h16.68a1 1 0 00.87-1.5l-7.5-13a1 1 0 00-1.74 0z" />
        </svg>
        <span className="text-xs text-[#EF7771]">{content}</span>
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
        className="h-12 w-12 rounded-full bg-[#6366F1] hover:bg-[#818CF8] text-white shadow-lg shadow-[#6366F1]/30 flex items-center justify-center relative transition-all duration-200 shrink-0 self-end m-3"
      >
        <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M18 10c0 3.866-3.582 7-8 7a8.84 8.84 0 01-3.641-.737L2 17l1.026-3.077A6.71 6.71 0 012 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#EF4444] text-white text-[10px] font-bold flex items-center justify-center">
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
      className="shrink-0 flex flex-col bg-[#0A0A0F] border-l border-[#1E1E2E] h-full relative"
      style={{ width: chatWidth }}
    >
      <div
        onMouseDown={handleDragStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#6366F1]/30 transition-colors -ml-px"
      />

      <div className="flex items-center gap-2 px-3 py-3 border-b border-[#1E1E2E] shrink-0">
        <div className="flex items-center gap-2 flex-1">
          <span className={`w-2 h-2 rounded-full ${isGenerating ? 'bg-[#6366F1] animate-pulse' : 'bg-[#34D399]'}`} />
          <span className="text-sm font-semibold text-[#E8E8ED]">AI Chat</span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded-lg hover:bg-[#1C1C2E] text-[#555570] hover:text-[#8888AA] transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M4.293 10.707a1 1 0 010-1.414l4-4A1 1 0 119.707 6.707L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 01-1.414 1.414l-4-4z" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {events.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center h-full">
            <div className="w-10 h-10 rounded-xl bg-[#6366F1]/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-[#6366F1]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5M7 4h10a3 3 0 013 3v7a3 3 0 01-3 3h-4l-4 3v-3H7a3 3 0 01-3-3V7a3 3 0 013-3z" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-[#E8E8ED]">Ask a question or request changes to your dashboard.</p>
              <p className="text-xs text-[#555570] mt-1">Try: "Add a CPU usage panel" or "Investigate high error rates"</p>
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

      <div className="shrink-0 p-3 border-t border-[#1E1E2E]">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            rows={1}
            disabled={isGenerating}
            className="w-full bg-[#141420] rounded-xl border border-[#2A2A3E] px-3 py-2.5 pr-20 text-sm text-[#E8E8ED] placeholder:text-[#444458] focus:border-[#6366F1]/50 focus:ring-[#6366F1]/50 focus:ring outline-none resize-none transition-colors disabled:opacity-50"
            style={{ minHeight: '44px', maxHeight: '120px' }}
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
              className="absolute right-12 bottom-2 w-7 h-7 rounded-lg bg-[#2A2A3E] hover:bg-[#EF7771]/20 text-[#8888AA] hover:text-[#EF7771] flex items-center justify-center transition-colors"
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
            className="absolute right-2 bottom-2 w-7 h-7 rounded-lg bg-[#6366F1] hover:bg-[#818CF8] text-white flex items-center justify-center transition-colors disabled:opacity-30"
            title="Send"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3.478 2.405a.75.75 0 01.82-.168l12.25 5.25a.75.75 0 010 1.378l-12.25 5.25a.75.75 0 01-1.043-.824l1.08-4.713H9.5a.75.75 0 000-1.5H4.335l-1.08-4.713a.75.75 0 01.223-.673z" />
            </svg>
          </button>
        </div>
        {!isGenerating && <p className="text-[10px] text-[#444458] text-right mt-1">Enter to send</p>}
      </div>
    </motion.div>
  );
}
