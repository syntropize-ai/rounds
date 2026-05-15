import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { apiClient } from '../api/client.js';
import { fadeIn } from '../animations.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { relativeTime } from '../utils/time.js';
import { useGlobalChat } from '../contexts/ChatContext.js';
import { groupEvents, liveAgentBlockId } from '../components/chat/event-processing.js';
import {
  UserMessage,
  AssistantMessage,
  ErrorMessage,
} from '../components/chat/MessageComponents.js';
import AgentActivityBlock from '../components/chat/AgentActivityBlock.js';
import { RoundsLogo } from '../components/RoundsLogo.js';
import { AISuggestionsInbox } from '../components/AISuggestionsInbox.js';

// Types

interface Dashboard {
  id: string;
  title: string;
  panels: unknown[];
  status: 'generating' | 'ready' | 'error';
  createdAt: string;
  updatedAt?: string;
}

interface ChatSession {
  id: string;
  title?: string | null;
  createdAt: string;
  updatedAt?: string;
}

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
  const navigate = useNavigate();
  const location = useLocation();
  const globalChat = useGlobalChat();
  const {
    events,
    isGenerating,
    sendMessage,
    stopGeneration,
    currentSessionId,
    loadSession,
  } = globalChat;

  const [input, setInput] = useState('');
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [deletingDashId, setDeletingDashId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const hasMessages = events.length > 0;

  const blocks = useMemo(() => groupEvents(events), [events]);
  const liveBlockId = useMemo(() => liveAgentBlockId(blocks, isGenerating), [blocks, isGenerating]);

  // Session id is owned by ChatProvider's React state (currentSessionId), not
  // the URL. Refresh / new tab = empty state = new conversation. Explicit
  // resume = Recents click in Navigation.tsx, which calls loadSession(id).
  // Home renders whatever state globalChat currently holds.

  const handleDeleteDashboard = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/dashboards/${id}`);
    if (!res.error) {
      setDashboards((prev) => prev.filter((d) => d.id !== id));
    }
  }, []);

  useEffect(() => {
    void apiClient.get<Dashboard[]>(`/dashboards?limit=6`).then((res) => {
      if (!res.error && Array.isArray(res.data))
        setDashboards(res.data.slice(0, 6));
    });
  }, []);

  const refreshSessions = useCallback(() => {
    void apiClient
      .get<{ sessions: ChatSession[] }>('/chat/sessions?limit=10')
      .then((res) => {
        if (!res.error && res.data?.sessions) setSessions(res.data.sessions);
      });
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      refreshSessions();
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating, refreshSessions]);

  // Auto-scroll on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      void loadSession(sessionId);
      // No URL mutation — session id lives in React state, the route stays '/'.
      // Browser back-button still works via the normal history stack since
      // we don't push entries for chat switches anymore.
      if (location.pathname !== '/') navigate('/');
    },
    [loadSession, navigate, location.pathname],
  );

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
        {isGenerating && (
          <button
            type="button"
            onClick={stopGeneration}
            className="absolute right-14 bottom-3 w-8 h-8 bg-surface-highest hover:bg-error/15 text-on-surface-variant hover:text-error flex items-center justify-center transition-colors rounded-full"
            title="Stop"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <rect x="5" y="5" width="10" height="10" rx="1" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || isGenerating}
          className="absolute right-3 bottom-3 w-9 h-9 bg-on-surface hover:bg-primary-container flex items-center justify-center text-surface-lowest transition-colors disabled:opacity-25 rounded-full"
          title="Send"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L12.586 11H3a1 1 0 110-2h9.586l-3.293-3.293a1 1 0 011.414-1.414l4 4z"
              clipRule="evenodd"
              transform="rotate(-90 10 10)"
            />
          </svg>
        </button>
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

            <motion.div
              className="mt-8"
              variants={fadeIn}
              initial="hidden"
              animate="visible"
              transition={{ delay: 0.23 }}
            >
              <AISuggestionsInbox />
            </motion.div>

            {sessions.length > 0 && (
              <motion.section
                className="mt-10"
                variants={fadeIn}
                initial="hidden"
                animate="visible"
                transition={{ delay: 0.25 }}
                aria-label="My conversations"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                    My conversations
                  </h2>
                  {currentSessionId && (
                    <button
                      type="button"
                      onClick={() => {
                        globalChat.startNewSession();
                        navigate('/', { replace: true });
                      }}
                      className="text-xs text-primary hover:text-primary-container transition-colors"
                    >
                      New chat
                    </button>
                  )}
                </div>
                <div className="grid gap-2">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => handleOpenSession(session.id)}
                      className={`flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        session.id === currentSessionId
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-outline-variant bg-surface-container/60 hover:border-outline hover:bg-surface-container'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-on-surface">
                          {session.title?.trim() || 'Untitled conversation'}
                        </span>
                        <span className="block text-xs text-on-surface-variant">
                          {relativeTime(session.updatedAt ?? session.createdAt)}
                        </span>
                      </span>
                      <svg
                        className="h-4 w-4 shrink-0 text-on-surface-variant"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  ))}
                </div>
              </motion.section>
            )}
          </div>
        </div>

        <ConfirmDialog
          open={deletingDashId !== null}
          title="Delete dashboard?"
          message="This dashboard and all its panels will be permanently deleted."
          onConfirm={() => {
            if (deletingDashId) void handleDeleteDashboard(deletingDashId);
            setDeletingDashId(null);
          }}
          onCancel={() => setDeletingDashId(null)}
        />
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
          {blocks.map((block) => {
            if (block.type === 'message') {
              const evt = block.event;
              if (evt.kind === 'error') {
                return (
                  <ErrorMessage
                    key={evt.id}
                    content={evt.content ?? 'An error occurred'}
                  />
                );
              }
              if (evt.message?.role === 'user') {
                return (
                  <UserMessage key={evt.id} content={evt.message.content} />
                );
              }
              if (evt.message?.role === 'assistant') {
                return (
                  <AssistantMessage
                    key={evt.id}
                    content={evt.message.content}
                  />
                );
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
