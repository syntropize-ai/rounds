import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeIn } from '../animations.js';
import { useGlobalChat } from '../contexts/ChatContext.js';
import { groupEvents, liveAgentBlockId } from '../components/chat/event-processing.js';
import ChatTranscript from '../components/chat/ChatTranscript.js';
import { RoundsLogo } from '../components/RoundsLogo.js';

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
  const {
    events,
    isGenerating,
    sendMessage,
    stopGeneration,
  } = globalChat;

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const hasMessages = events.length > 0;

  const blocks = useMemo(() => groupEvents(events), [events]);
  const liveBlockId = useMemo(() => liveAgentBlockId(blocks, isGenerating), [blocks, isGenerating]);

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
    if (!trimmed || isGenerating) return;
    void sendMessage(trimmed);
    setInput('');
  }, [input, isGenerating, sendMessage]);

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
    <div className="relative group">
      <div className="relative">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything about your systems..."
          rows={1}
          disabled={isGenerating}
          className="w-full bg-surface-container border border-outline focus:border-on-surface/30 py-4 pl-5 pr-16 text-[15px] text-on-surface placeholder-on-surface-variant/70 outline-none resize-none transition-[border-color,box-shadow,background-color] disabled:opacity-50 rounded-[26px] shadow-[0_18px_60px_rgba(15,18,22,0.10),0_1px_2px_rgba(15,18,22,0.08)] focus:shadow-[0_22px_70px_rgba(15,18,22,0.14),0_1px_2px_rgba(15,18,22,0.08)]"
          style={{ minHeight: '58px', maxHeight: '220px' }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
          }}
        />
        {isGenerating ? (
          <button
            type="button"
            onClick={stopGeneration}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-surface-high hover:bg-surface-highest text-on-surface flex items-center justify-center transition-colors"
            title="Stop"
            aria-label="Stop"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        ) : (
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-surface-high hover:bg-surface-highest text-on-surface flex items-center justify-center transition-colors disabled:opacity-40 disabled:hover:bg-surface-high"
          title="Send"
          aria-label="Send"
        >
          <svg
            className="w-5 h-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
        )}
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
              <div className="inline-flex items-center justify-center mb-5">
                <RoundsLogo className="w-12 h-12 text-on-surface" size={48} />
              </div>
              <h1 className="text-[32px] md:text-[42px] font-medium tracking-normal mb-3 leading-tight text-on-surface">
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
            blocks={blocks}
            liveBlockId={liveBlockId}
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
