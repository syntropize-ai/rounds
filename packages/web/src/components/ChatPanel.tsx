import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { slideIn } from '../animations.js';
import type { ChatEvent } from '../hooks/useDashboardChat.js';
import { groupEvents } from './chat/event-processing.js';
import type { Block } from './chat/event-processing.js';
import { UserMessage, AssistantMessage, ErrorMessage } from './chat/MessageComponents.js';
import AgentActivityBlock from './chat/AgentActivityBlock.js';
import { OpenObsLogo } from './OpenObsLogo.js';

// Types

interface Props {
  events: ChatEvent[];
  isGenerating: boolean;
  onSendMessage: (content: string) => void;
  onStop?: () => void;
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
      if (blocks[i]!.type === 'agent') return (blocks[i] as Extract<Block, { type: 'agent' }>).id;
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
          <OpenObsLogo
            className={`w-7 h-7 text-tertiary${isGenerating ? ' animate-spin-slow' : ''}`}
            size={28}
          />
          <div>
            <p className="text-xs font-bold text-tertiary uppercase tracking-tight">OpenObs</p>
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
        {events.length === 0 && (
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
            placeholder="Ask anything..."
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
