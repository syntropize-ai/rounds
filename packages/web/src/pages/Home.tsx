import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { apiClient } from '../api/client.js';
import { DarkCard } from '../components/ui/DarkCard.js';
import { fadeIn } from '../animations.js';
import ConfirmDialog from '../components/ConfirmDialog.js';

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

// Helpers

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Quick-start suggestions

const SUGGESTIONS = [
  { icon: 'K8s', label: 'K8s cluster overview', prompt: 'Create a Kubernetes cluster overview dashboard with node health, pod status, and resource utilization.' },
  { icon: 'Mesh', label: 'Istio service mesh', prompt: 'Create an Istio service mesh dashboard with request rates, error rates, and p95 latency.' },
  { icon: 'DB', label: 'Node health dashboard', prompt: 'Create a node health dashboard with CPU, memory, disk, and network metrics.' },
  { icon: 'Redis', label: 'Redis monitoring', prompt: 'Create a Redis monitoring dashboard with memory usage, hit rate, and command throughput.' },
  { icon: 'Why', label: 'Why is latency high?', prompt: 'Why is my service experiencing high latency?' },
  { icon: 'Error', label: 'Investigate error spike', prompt: 'Investigate the recent error rate spike in my services' },
];

// Main

export default function Home() {
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState('');
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  const [intentResult, setIntentResult] = useState<{ intent: string; summary?: string } | null>(null);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [deletingDashId, setDeletingDashId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleDeleteDashboard = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/dashboards/${id}`);
    if (!res.error) {
      setDashboards((prev) => prev.filter((d) => d.id !== id));
    }
  }, []);

  useEffect(() => {
    void apiClient.get<Dashboard[]>(`/dashboards?limit=6`).then((res) => {
      if (!res.error) setDashboards(res.data.slice(0, 6));
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

      setSubmitting(true);
      setSubmitError(null);
      setThinkingText(null);
      setIntentResult(null);

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      try {
        await apiClient.postStream(
          '/intent',
          { message: trimmed },
          (eventType: string, rawData: string) => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(rawData) as Record<string, unknown>;
            } catch {
              return;
            }

            switch (eventType) {
              case 'thinking':
                setThinkingText((parsed.content as string) ?? 'Thinking...');
                break;
              case 'intent':
                setIntentResult({ intent: parsed.intent as string });
                break;
              case 'done': {
                const intent = parsed.intent as string;
                const summary = parsed.summary as string | undefined;
                setIntentResult({ intent, summary });
                setThinkingText(null);

                // Navigate after a brief moment so user sees the result.
                setTimeout(() => {
                  const nav = parsed.navigate as string;
                  if (intent === 'alert') {
                    navigate(nav || '/alerts');
                  } else {
                    navigate(nav || '/', { state: { initialPrompt: trimmed } });
                  }
                }, 800);
                break;
              }
              case 'error':
                setSubmitError((parsed.message as string) ?? 'Something went wrong');
                setSubmitting(false);
                setThinkingText(null);
                break;
              default:
                break;
            }
          },
          abortRef.current.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setSubmitError('Network error - please try again.');
        }
        setSubmitting(false);
        setThinkingText(null);
      }
    },
    [prompt, submitting, navigate]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleSuggestionClick = (s: (typeof SUGGESTIONS)[number]) => {
    setPrompt(s.prompt);
    textareaRef.current?.focus();
  };

  return (
    <div className="min-h-full bg-[#0A0A0F] flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <motion.div
          className="text-center mb-8"
          variants={fadeIn}
          initial="hidden"
          animate="visible"
        >
          <div className="relative inline-block mb-6">
            <div className="absolute inset-0 -m-16 rounded-full bg-[#6366F1]/20 blur-xl" />
            <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-[#6366F1] to-[#58C5C6] flex items-center justify-center shadow-lg shadow-[#6366F1]/25">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5l7.5 4.5v6L12 19.5 4.5 15v-6L12 4.5z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 12l7.5-4.5M12 12L4.5 7.5M12 12v7.5" />
              </svg>
            </div>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#E8E8ED] mb-2">
            What can I help you with?
          </h1>
          <p className="text-[#555570] text-base">
            Build dashboards, investigate issues, or ask anything about your infrastructure.
          </p>
        </motion.div>

        <motion.div
          className="w-full max-w-2xl"
          variants={fadeIn}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.05 }}
        >
          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
          >
            <div
              className={`rounded-2xl border overflow-hidden shadow-2xl transition-all duration-300 ${
                focused
                  ? 'bg-[#141420] border-[#6366F1]/40 shadow-[#6366F1]/10'
                  : 'bg-[#111118] border-[#2A2A3E] hover:border-[#3A3A4E]'
              }`}
            >
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Ask me to build a dashboard, investigate an issue, or explore your metrics..."
                rows={3}
                disabled={submitting}
                className="w-full bg-transparent px-5 py-4 text-[15px] text-[#E8E8ED] placeholder:text-[#444450] focus:outline-none resize-none disabled:opacity-50 leading-relaxed"
              />

              <div className="flex items-center gap-2 px-4 py-2.5">
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#1C1C2E]/60 rounded-lg text-xs text-[#555570]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>Prometheus</span>
                </div>

                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#1C1C2E]/60 rounded-lg text-xs text-[#555570]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#6366F1]" />
                  <span>Claude</span>
                </div>

                <div className="flex-1" />

                {submitError && (
                  <span className="text-xs text-red-400 truncate max-w-xs">{submitError}</span>
                )}

                <button
                  type="submit"
                  disabled={!prompt.trim() || submitting}
                  className={`relative flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 ${
                    prompt.trim()
                      ? 'bg-[#6366F1] hover:bg-[#818CF8] text-white shadow-md shadow-[#6366F1]/25 scale-100'
                      : 'bg-[#1C1C2E] text-[#444458] scale-95'
                  }`}
                >
                  {submitting ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M7.999 15.001l8.586-8.586-1.414-1.414L6.585 13.587V8h-2v9h9v-2H7.999z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </form>

          {!submitting && (
            <div className="text-center text-[10px] mt-2 text-[#333345]">
              Press <kbd className="px-1 py-0.5 rounded bg-[#1C1C2E] text-[#555570] font-mono text-[10px]">Enter</kbd> to send,
              <kbd className="ml-1 px-1 py-0.5 rounded bg-[#1C1C2E] text-[#555570] font-mono text-[10px]">Shift+Enter</kbd> for newline
            </div>
          )}

          {submitting && (
            <div className="mt-4 rounded-xl border border-[#2A2A3E] bg-[#111118] px-4 py-3.5 space-y-2.5">
              {thinkingText && (
                <div className="flex items-center gap-2.5">
                  <span className="inline-block w-4 h-4 rounded-full animate-spin shrink-0 border-2 border-[#2A2A3E] border-t-[#6366F1]" />
                  <span className="text-sm text-[#8888AA]">{thinkingText}</span>
                </div>
              )}

              {intentResult && (
                <div className="flex items-center gap-2.5">
                  <span className="flex h-4 w-4 items-center justify-center shrink-0">
                    <span className="w-2 h-2 rounded-full bg-[#6366F1] animate-pulse" />
                  </span>
                  <span className="text-xs text-[#E8E8ED]">
                    Intent classified:
                    <span className="text-[#E8E8ED] font-medium ml-1">
                      {intentResult.intent === 'alert'
                        ? 'Alert'
                        : intentResult.intent === 'investigate'
                          ? 'Investigation'
                          : 'Dashboard'}
                    </span>
                  </span>
                </div>
              )}

              {intentResult?.summary && (
                <p className="text-xs text-[#22C55E] pl-6">{intentResult.summary}</p>
              )}
            </div>
          )}

          {!submitting && (
            <motion.div
              className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-6 max-w-2xl w-full"
              variants={fadeIn}
              initial="hidden"
              animate="visible"
              transition={{ delay: 0.1 }}
            >
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => handleSuggestionClick(s)}
                  className="flex items-center gap-2 px-3 py-2.5 text-left text-[13px] text-[#8888AA] bg-[#111118] border border-[#1E1E2E] rounded-xl hover:border-[#6366F1]/30 hover:bg-[#141420] transition-all duration-200 group"
                >
                  <span className="text-base shrink-0 opacity-90 group-hover:opacity-100 transition-opacity">
                    {s.icon}
                  </span>
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </motion.div>
          )}
        </motion.div>

        {dashboards.length > 0 && (
          <motion.section
            className="mt-8 pb-10 max-w-6xl mx-auto w-full"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            transition={{ delay: 0.15 }}
          >
            <DarkCard className="flex items-center justify-between mb-5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#555570]">
                Recent
              </h2>
              <Link
                to="/dashboards"
                className="text-xs text-[#6366F1] hover:text-[#818CF8] transition-colors"
              >
                View all
              </Link>
            </DarkCard>

            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
              {dashboards.map((dash) => (
                <div
                  key={dash.id}
                  className="shrink-0 w-48 relative group/home-card"
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/dashboards/${dash.id}`)}
                    className="w-full text-left bg-[#111118] rounded-xl border border-[#1E1E2E] p-3.5 cursor-pointer hover:border-[#6366F1]/30 hover:bg-[#141420] transition-all duration-200"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          dash.status === 'generating'
                            ? 'bg-amber-400 animate-pulse'
                            : dash.status === 'error'
                              ? 'bg-red-400'
                              : 'bg-emerald-500'
                        }`}
                      />
                      <span className="text-[10px] text-[#444458]">
                        {relativeTime(dash.updatedAt ?? dash.createdAt)}
                      </span>
                    </div>

                    <div className="text-sm font-medium text-[#C8C8D8] line-clamp-2 mb-1.5">
                      {dash.title}
                    </div>
                    <div className="text-xs text-[#444458]">
                      {dash.panels.length} panel{dash.panels.length === 1 ? '' : 's'}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeletingDashId(dash.id)}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-[#111118]/90 border border-[#1E1E2E] text-[#444458] hover:text-[#EF4444] hover:border-[#EF4444]/30 opacity-0 group-hover/home-card:opacity-100 transition-all"
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

        <motion.section
          className="w-full pb-10 max-w-6xl mx-auto"
          variants={fadeIn}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.2 }}
        >
          <DarkCard className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {alertCount !== null && alertCount > 0 ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                  <span className="text-sm font-semibold text-[#E8E8ED]">
                    {alertCount} anomaly{alertCount === 1 ? '' : 'ies'} detected
                  </span>
                </>
              ) : alertCount === 0 ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="text-sm text-[#8888AA]">No active anomalies</span>
                </>
              ) : (
                <span className="text-sm text-[#555570]">Loading alerts...</span>
              )}
            </div>
            <Link
              to="/feed"
              className="text-sm text-[#6366F1] hover:text-[#818CF8] transition-colors font-medium"
            >
              View Feed
            </Link>
          </DarkCard>
        </motion.section>

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
    </div>
  );
}
