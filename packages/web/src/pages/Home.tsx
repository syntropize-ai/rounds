import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { apiClient } from '../api/client.js';
import { fadeIn } from '../animations.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { relativeTime } from '../utils/time.js';
import { useGlobalChat } from '../contexts/ChatContext.js';

// Types

interface Dashboard {
  id: string;
  title: string;
  panels: unknown[];
  status: 'generating' | 'ready' | 'error';
  createdAt: string;
  updatedAt?: string;
}

interface FeedPage {
  total: number;
  items: unknown[];
}

// Quick action cards

const QUICK_ACTIONS = [
  {
    category: 'Performance',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    colorClass: 'text-primary',
    prompt: 'Analyze CPU spike in checkout-service',
    label: '"Analyze CPU spike in checkout-service"',
  },
  {
    category: 'Dashboards',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M7 16l4-4 4 4 4-4" />
      </svg>
    ),
    colorClass: 'text-tertiary',
    prompt: 'Create a dashboard for user login latency',
    label: '"Create a dashboard for user login latency"',
  },
  {
    category: 'Incident',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    ),
    colorClass: 'text-error',
    prompt: 'Explain the recent 5xx error surge',
    label: '"Explain the recent 5xx error surge"',
  },
];

// Main

export default function Home() {
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const globalChat = useGlobalChat();

  const [prompt, setPrompt] = useState('');
  const [focused, setFocused] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [deletingDashId, setDeletingDashId] = useState<string | null>(null);

  const submitting = globalChat.isGenerating;

  const handleDeleteDashboard = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/dashboards/${id}`);
    if (!res.error) {
      setDashboards((prev) => prev.filter((d) => d.id !== id));
    }
  }, []);

  useEffect(() => {
    void apiClient.get<Dashboard[]>(`/dashboards?limit=6`).then((res) => {
      if (!res.error && Array.isArray(res.data)) setDashboards(res.data.slice(0, 6));
    });
  }, []);

  useEffect(() => {
    void apiClient.get<FeedPage>(`/feed?limit=1`).then((res) => {
      if (!res.error) setAlertCount(res.data.total);
    });
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmed = prompt.trim();
      if (!trimmed || submitting) return;

      setSubmitError(null);
      setPrompt('');

      // Send through the global chat — the agent will create a dashboard if needed
      // and emit a navigate event that Layout handles automatically
      void globalChat.sendMessage(trimmed);
    },
    [prompt, submitting, globalChat],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleQuickAction = (actionPrompt: string) => {
    setPrompt(actionPrompt);
    textareaRef.current?.focus();
  };

  return (
    <div className="min-h-full bg-surface-container flex flex-col items-center justify-center relative">
      {/* Center content */}
      <div className="w-full max-w-3xl px-6 flex flex-col items-center">
        {/* Editorial headline */}
        <motion.div
          className="mb-12 text-center"
          variants={fadeIn}
          initial="hidden"
          animate="visible"
        >
          <h1 className="font-[Manrope] text-5xl font-extrabold tracking-tight text-white mb-4 leading-tight">
            Welcome, what are we{' '}
            <span className="text-primary italic">investigating</span> today?
          </h1>
          <p className="text-on-surface-variant text-lg">
            OpenObs is analyzing telemetry from Prometheus in real-time.
          </p>
        </motion.div>

        {/* Prompt input */}
        <motion.div
          className="w-full relative group"
          variants={fadeIn}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.05 }}
        >
          <div
            className={`absolute inset-0 blur-2xl rounded-3xl transition-all duration-500 ${
              focused ? 'bg-primary/20' : 'bg-primary/10'
            }`}
          />

          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
          >
            <div className="relative bg-surface-bright/80 backdrop-blur-xl rounded-[2rem] p-6 shadow-2xl">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex items-center justify-center w-10 h-10 rounded-full bg-surface-high">
                  <svg className="w-5 h-5 text-primary" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z" />
                  </svg>
                </div>
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  placeholder="Ask OpenObs to analyze, explain, or visualize..."
                  rows={2}
                  disabled={submitting}
                  className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none text-sm text-on-surface placeholder:text-on-surface-variant/50 resize-none py-2"
                />
              </div>

              <div className="mt-4 flex justify-between items-center">
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="p-2 rounded-xl hover:bg-surface-highest text-on-surface-variant transition-colors"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="p-2 rounded-xl hover:bg-surface-highest text-on-surface-variant transition-colors"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </button>
                </div>

                {submitError && (
                  <span className="text-xs text-error truncate max-w-xs">{submitError}</span>
                )}

                <button
                  type="submit"
                  disabled={!prompt.trim() || submitting}
                  className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 shrink-0 ${
                    prompt.trim()
                      ? 'bg-primary text-on-primary-fixed hover:opacity-90'
                      : 'bg-surface-high text-on-surface-variant/40'
                  }`}
                >
                  {submitting ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15M19.5 4.5H8.5M19.5 4.5v11" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </form>

          {/* Thinking / intent status */}
          {submitting && (
            <div className="mt-4 flex items-center justify-center gap-2.5 py-3">
              <span className="inline-block w-4 h-4 rounded-full animate-spin border-2 border-outline border-t-primary" />
              <span className="text-xs text-on-surface-variant">Processing...</span>
            </div>
          )}
        </motion.div>

        {/* Quick action cards */}
        {!submitting && (
          <motion.div
            className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 w-full"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            transition={{ delay: 0.1 }}
          >
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.category}
                type="button"
                onClick={() => handleQuickAction(action.prompt)}
                className="p-5 bg-surface-low hover:bg-surface-high rounded-2xl text-left transition-all duration-200 group"
              >
                <div className={`flex items-center gap-2 ${action.colorClass} mb-2`}>
                  {action.icon}
                  <span className="text-[10px] font-bold uppercase tracking-widest">
                    {action.category}
                  </span>
                </div>
                <p className="text-on-surface-variant text-sm leading-relaxed group-hover:text-white transition-colors">
                  {action.label}
                </p>
              </button>
            ))}
          </motion.div>
        )}

        {/* Recent dashboards */}
        {dashboards.length > 0 && (
          <motion.section
            className="mt-12 w-full"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            transition={{ delay: 0.15 }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                Recent
              </h2>
              <Link
                to="/dashboards"
                className="text-xs text-primary hover:text-primary-container transition-colors"
              >
                View all
              </Link>
            </div>

            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
              {dashboards.map((dash) => (
                <div key={dash.id} className="shrink-0 w-48 relative group/home-card">
                  <button
                    type="button"
                    onClick={() => navigate(`/dashboards/${dash.id}`)}
                    className="w-full text-left bg-surface-low hover:bg-surface-high rounded-xl p-3.5 cursor-pointer transition-all duration-200"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          dash.status === 'generating'
                            ? 'bg-amber-400 animate-pulse'
                            : dash.status === 'error'
                              ? 'bg-error'
                              : 'bg-emerald-500'
                        }`}
                      />
                      <span className="text-[10px] text-on-surface-variant/60">
                        {relativeTime(dash.updatedAt ?? dash.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm font-medium text-on-surface line-clamp-2 mb-1.5">
                      {dash.title}
                    </div>
                    <div className="text-xs text-on-surface-variant/60">
                      {dash.panels.length} panel{dash.panels.length === 1 ? '' : 's'}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeletingDashId(dash.id)}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface/90 text-on-surface-variant hover:text-error opacity-0 group-hover/home-card:opacity-100 transition-all"
                    title="Delete"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M8.5 2a1 1 0 00-1 1V4H5a1 1 0 000 2h.293l.853 9.386A2 2 0 008.138 17h3.724a2 2 0 001.992-1.614L14.707 6H15a1 1 0 100-2h-2.5V3a1 1 0 00-1-1h-3zM9.5 4h1V3h-1v1z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </motion.section>
        )}

        {/* Alert status bar */}
        <motion.div
          className="mt-8 mb-10 w-full"
          variants={fadeIn}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center justify-between bg-surface-low rounded-xl px-5 py-3">
            <div className="flex items-center gap-3">
              {alertCount !== null && alertCount > 0 ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-error animate-pulse" />
                  <span className="text-sm font-semibold text-on-surface">
                    {alertCount} anomaly{alertCount === 1 ? '' : 'ies'} detected
                  </span>
                </>
              ) : alertCount === 0 ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="text-sm text-on-surface-variant">No active anomalies</span>
                </>
              ) : (
                <span className="text-sm text-on-surface-variant/60">Loading alerts...</span>
              )}
            </div>
            <Link
              to="/feed"
              className="text-sm text-primary hover:text-primary-container transition-colors font-medium"
            >
              View Feed
            </Link>
          </div>
        </motion.div>
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
