import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { slideIn } from '../animations.js';
import type { ChatEvent } from '../hooks/useDashboardChat.js';
import { groupEvents, liveAgentBlockId } from './chat/event-processing.js';
import { UserMessage, AssistantMessage, ErrorMessage } from './chat/MessageComponents.js';
import AgentActivityBlock from './chat/AgentActivityBlock.js';
import AskUserPrompt from './chat/AskUserPrompt.js';
import { DatasourceChoiceChip } from './chat/DatasourceChoiceChip.js';
import InlineChartMessage from './InlineChartMessage.js';
import { RoundsLogo } from './RoundsLogo.js';

// Types

interface Props {
  events: ChatEvent[];
  isGenerating: boolean;
  onSendMessage: (content: string) => void;
  onStop?: () => void;
  /**
   * Result of the most recent loadSession call. When set, the panel renders
   * a distinct empty state ("session not found" / "failed to load") instead
   * of the default empty-chat hint, so the user can tell history-load
   * problems apart from a never-used session.
   */
  loadError?: 'not-found' | 'network' | null;
  /** Retry handler for the network-error banner. */
  onRetryLoad?: () => void;
}

// Main component

export default function ChatPanel({ events, isGenerating, onSendMessage, onStop, loadError = null, onRetryLoad }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [input, setInput] = useState('');
  const [unread, setUnread] = useState(0);
  const [chatWidth, setChatWidth] = useState(380);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevEventCountRef = useRef(events.length);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const blocks = useMemo(() => groupEvents(events), [events]);
  const liveBlockId = useMemo(() => liveAgentBlockId(blocks, isGenerating), [blocks, isGenerating]);

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

  const chatWidthRef = useRef(chatWidth);
  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: chatWidthRef.current };
  }, []);

  useEffect(() => {
    const handleDragMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - e.clientX;
      const newWidth = Math.min(700, Math.max(280, dragRef.current.startWidth + delta));
      setChatWidth(newWidth);
    };
    const handleDragEnd = () => {
      dragRef.current = null;
    };
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, []);

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
        className="h-11 w-11 bg-primary hover:bg-primary-container text-white flex items-center justify-center relative transition-colors shrink-0 self-end m-3"
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
      className="shrink-0 flex flex-col bg-surface-lowest border-l border-outline-variant h-full relative"
      style={{ width: chatWidth }}
    >
      <div
        onMouseDown={handleDragStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 transition-colors -ml-px"
      />

      <div className="flex items-center justify-between px-4 py-4 border-b border-outline-variant shrink-0">
        <div className="flex items-center gap-3 flex-1">
          <RoundsLogo
            className="w-7 h-7 text-on-surface"
            size={28}
            animated={isGenerating}
          />
          <div>
            <p className="text-xs font-semibold text-on-surface">Rounds</p>
            <p className="text-[10px] text-on-surface-variant">
              {isGenerating ? 'Working' : 'Ready'}
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
        {/* Inline banner for transient load failures: events may still be
            present (e.g., a partially loaded session), so we show the
            banner above them rather than as a full-screen empty state. */}
        {loadError === 'network' && events.length > 0 && (
          <div className="mb-3 rounded-lg bg-error/10 border border-error/30 px-3 py-2 text-xs text-error flex items-center justify-between gap-3">
            <span>Failed to load conversation history.</span>
            {onRetryLoad && (
              <button
                type="button"
                onClick={onRetryLoad}
                className="shrink-0 px-2 py-0.5 rounded border border-error/40 hover:bg-error/20 transition-colors text-error font-medium"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {events.length === 0 && loadError === 'not-found' && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center h-full">
            <div className="w-10 h-10 rounded-xl bg-error/10 flex items-center justify-center text-error">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-on-surface">Session not found</p>
              <p className="text-xs text-on-surface-variant mt-1">
                The conversation you opened doesn't exist on the server (it may have been deleted or expired).
              </p>
            </div>
          </div>
        )}

        {events.length === 0 && loadError === 'network' && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center h-full">
            <div className="w-10 h-10 rounded-xl bg-error/10 flex items-center justify-center text-error">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376C1.83 17.755 2.821 19.5 4.43 19.5h15.14c1.61 0 2.6-1.745 1.733-3.374L13.732 4.125c-.802-1.5-2.662-1.5-3.464 0L2.697 16.126z" />
              </svg>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-on-surface">Failed to load conversation history</p>
              {onRetryLoad && (
                <button
                  type="button"
                  onClick={onRetryLoad}
                  className="px-3 py-1 rounded-md border border-outline-variant hover:bg-surface-high transition-colors text-xs text-on-surface"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}

        {events.length === 0 && !loadError && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 text-center h-full">
            <div className="w-10 h-10 rounded-xl bg-tertiary/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5M7 4h10a3 3 0 013 3v7a3 3 0 01-3 3h-4l-4 3v-3H7a3 3 0 01-3-3V7a3 3 0 013-3z" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-on-surface">Ask me to build dashboards, investigate issues, or create alerts.</p>
              <p className="text-xs text-on-surface-variant mt-1">Try: "Create a Kubernetes monitoring dashboard" or "Investigate high error rates"</p>
            </div>
          </div>
        )}

        {blocks.map((block) => {
          if (block.type === 'message') {
            const evt = block.event;
            if (evt.kind === 'error') {
              return <ErrorMessage key={evt.id} content={evt.content ?? 'An error occurred'} />;
            }
            if (evt.kind === 'ask_user') {
              return (
                <AskUserPrompt
                  key={evt.id}
                  question={evt.question ?? ''}
                  options={evt.options ?? []}
                  onSelect={(id) => onSendMessage(`option:${id}`)}
                />
              );
            }
            if (evt.kind === 'inline_chart' && evt.inlineChart) {
              const c = evt.inlineChart;
              return (
                <InlineChartMessage
                  key={evt.id}
                  id={c.id}
                  initialQuery={c.query}
                  initialTimeRange={c.timeRange}
                  initialSeries={c.series}
                  initialSummary={c.summary}
                  metricKind={c.metricKind}
                  datasourceId={c.datasourceId}
                  pivotSuggestions={c.pivotSuggestions}
                  warnings={c.warnings}
                  onSendMessage={onSendMessage}
                />
              );
            }
            if (evt.kind === 'ds_choice') {
              return (
                <DatasourceChoiceChip
                  key={evt.id}
                  chosenName={evt.chosenName ?? ''}
                  reason={evt.chooseReason ?? ''}
                  confidence={evt.confidence ?? 'low'}
                  alternatives={evt.alternatives ?? []}
                  onSwitch={(altId) => onSendMessage(`option:${altId}`)}
                />
              );
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
                isLive={block.id === liveBlockId}
              />
            );
          }

          return null;
        })}

        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-4 py-4 bg-surface-lowest border-t border-outline-variant space-y-4">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything..."
            rows={1}
            disabled={isGenerating}
            className="w-full bg-surface-container border border-outline-variant focus:border-primary py-3.5 pl-4 pr-14 text-sm text-on-surface placeholder-on-surface-variant outline-none resize-none transition-colors disabled:opacity-50"
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
              className="absolute right-12 bottom-3 w-8 h-8 bg-surface-highest hover:bg-error/20 text-on-surface-variant hover:text-error flex items-center justify-center transition-colors"
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
            className="absolute right-3 bottom-3 w-8 h-8 bg-primary hover:bg-primary-container flex items-center justify-center text-on-primary-fixed transition-colors disabled:opacity-30"
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
