import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { fadeIn } from '../animations.js';
import { useGlobalChat } from '../contexts/ChatContext.js';
import ChatTranscript from '../components/chat/ChatTranscript.js';
import { QueuedMessageStack } from '../components/ChatPanel.js';

// Types


// Quick action cards

const QUICK_ACTIONS = [
  {
    category: 'Investigate',
    icon: (
      <svg
        className="w-4 h-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
    ),
    colorClass: 'text-on-surface',
    prompt: 'Why is checkout latency high right now?',
    label: 'Investigate checkout latency',
  },
  {
    category: 'Build',
    icon: (
      <svg
        className="w-4 h-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 3v18h18M7 16l4-4 4 4 4-4"
        />
      </svg>
    ),
    colorClass: 'text-secondary',
    prompt: 'Create a dashboard for http latency',
    label: 'Create HTTP latency dashboard',
  },
  {
    category: 'Alert',
    icon: (
      <svg
        className="w-4 h-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
        />
      </svg>
    ),
    colorClass: 'text-error',
    prompt: 'Alert me when p95 latency is above 500ms',
    label: 'Alert on p95 > 500ms',
  },
];

// Main

export default function Home() {
  const globalChat = useGlobalChat();
  const location = useLocation();
  const {
    events,
    queuedMessages,
    isGenerating,
    sendMessage,
    updateQueuedMessage,
    deleteQueuedMessage,
    stopGeneration,
  } = globalChat;

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const hasMessages = events.length > 0;

  useEffect(() => {
    const state = location.state as { resumeChat?: boolean } | null;
    if (state?.resumeChat) {
      return;
    }
    globalChat.startNewSession();
    // Run only when Home is entered. `globalChat` is intentionally omitted
    // because it changes as events stream in; including it would clear the
    // conversation on every chat update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Auto-scroll on new events. First mount jumps to the bottom instantly
  // (no animated scroll-from-top when the page reloads with N existing
  // messages); subsequent length changes smooth-scroll.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (events.length === 0) return;
    const behavior: ScrollBehavior = didInitialScrollRef.current ? 'smooth' : 'instant';
    bottomRef.current?.scrollIntoView({ behavior });
    didInitialScrollRef.current = true;
  }, [events.length]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    void sendMessage(trimmed);
    setInput('');
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.style.height = '52px';
    });
  }, [input, sendMessage]);

  const resizeInput = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = '52px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 120)}px`;
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickAction = (actionPrompt: string) => {
    void sendMessage(actionPrompt);
  };

  // Reusable input component (used in both modes)
  const inputArea = (
    <div className="relative group space-y-3">
      {queuedMessages.length > 0 && (
        <QueuedMessageStack
          queuedMessages={queuedMessages}
          onUpdate={updateQueuedMessage}
          onDelete={deleteQueuedMessage}
        />
      )}
      <div className="relative">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            resizeInput(e.target);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything about your systems..."
          rows={1}
          className="w-full rounded-2xl border border-outline-variant bg-surface-container-low py-[14px] pl-5 pr-24 text-[15px] leading-5 text-on-surface shadow-[0_14px_42px_rgba(15,18,22,0.10),0_1px_2px_rgba(15,18,22,0.08)] outline-none resize-none transition-[border-color,box-shadow,background-color] placeholder:text-on-surface-variant hover:bg-surface-container focus:border-primary focus:bg-surface-container focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_12%,transparent),0_18px_52px_rgba(15,18,22,0.12)]"
          style={{
            height: '52px',
            maxHeight: '120px',
            borderTopLeftRadius: queuedMessages.length > 0 ? 0 : undefined,
            borderTopRightRadius: queuedMessages.length > 0 ? 0 : undefined,
          }}
        />
        {isGenerating && !input.trim() ? (
          <button
            type="button"
            onClick={stopGeneration}
            className="absolute right-3 top-[26px] flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-high hover:text-on-surface"
            title="Stop"
            aria-label="Stop"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <rect x="5" y="5" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim()}
          className="absolute right-3 top-[26px] flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-high hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
          title="Send"
          aria-label="Send"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path fillRule="evenodd" d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L12.586 11H3a1 1 0 110-2h9.586l-3.293-3.293a1 1 0 011.414-1.414l4 4z" clipRule="evenodd" transform="rotate(-90 10 10)" />
          </svg>
        </button>
        )}
        {isGenerating && input.trim() ? (
          <button
            type="button"
            onClick={stopGeneration}
            className="absolute right-12 top-[26px] flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-high hover:text-on-surface"
            title="Stop"
            aria-label="Stop"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <rect x="5" y="5" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════
  // MODE 1: Initial state (no messages) — centered hero + input
  // ═══════════════════════════════════════════════════════════════
  if (!hasMessages) {
    return (
      <div className="relative h-full bg-surface-lowest overflow-y-auto">
        <div className="relative min-h-full flex flex-col items-center justify-center px-6 py-16">
          <div className="w-full max-w-4xl">
            {/* Hero */}
            <motion.div
              className="text-center mb-9"
              variants={fadeIn}
              initial="hidden"
              animate="visible"
            >
              <h1 className="text-[26px] md:text-[34px] font-medium tracking-tight mb-3 leading-[1.15] text-on-surface">
                How can Rounds help?
              </h1>
              <p className="text-on-surface-variant text-sm md:text-base max-w-xl mx-auto leading-relaxed">
                Ask it to build, explain, investigate, or prepare an approved
                fix.
              </p>
            </motion.div>

            {/* Input — centered under hero */}
            <motion.div
              variants={fadeIn}
              initial="hidden"
              animate="visible"
              transition={{ delay: 0.1 }}
            >
              {inputArea}
            </motion.div>

            {/* Quick action suggestions */}
            <motion.div
              className="mt-5 grid w-full grid-cols-3 gap-2.5"
              variants={fadeIn}
              initial="hidden"
              animate="visible"
              transition={{ delay: 0.2 }}
            >
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.category}
                  type="button"
                  onClick={() => handleQuickAction(action.prompt)}
                  className="group/action inline-flex min-w-0 items-center justify-center gap-2 rounded-full border border-outline-variant bg-surface-container/70 px-3.5 py-2 text-[13px] text-on-surface-variant shadow-[0_1px_2px_rgba(15,18,22,0.04)] transition-[background-color,border-color,color] hover:border-outline hover:bg-surface-container hover:text-on-surface"
                >
                  <span className={`${action.colorClass} shrink-0`}>
                    {action.icon}
                  </span>
                  <span className="truncate">{action.label}</span>
                </button>
              ))}
            </motion.div>

          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // MODE 2: Conversation state — messages fill screen, input at bottom
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="h-full bg-surface-lowest flex flex-col">
      {/* Scrollable messages area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 w-full pt-8 pb-4">
          <ChatTranscript
            events={events}
            isGenerating={isGenerating}
            onSendMessage={sendMessage}
          />
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input fixed at bottom */}
      <div className="shrink-0 border-t border-outline-variant bg-surface-lowest">
        <div className="max-w-3xl mx-auto px-6 py-4 w-full">
          {inputArea}
          <p className="mt-2 text-[10px] text-center text-on-surface-variant/40">
            Rounds can make mistakes. Check important info.
          </p>
        </div>
      </div>
    </div>
  );
}
