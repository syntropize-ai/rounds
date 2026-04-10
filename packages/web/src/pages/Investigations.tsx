import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { relativeTime } from '../utils/time.js';

// Types — matches the summary returned by GET /investigations

interface InvestigationSummary {
  id: string;
  status: string;
  intent: string;
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

// Helpers

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  planning:      { bg: 'bg-blue-500/15',   text: 'text-blue-400',    label: 'Planning' },
  investigating: { bg: 'bg-amber-500/15',  text: 'text-amber-400',   label: 'Investigating' },
  evidencing:    { bg: 'bg-amber-500/15',  text: 'text-amber-400',   label: 'Collecting Evidence' },
  explaining:    { bg: 'bg-purple-500/15', text: 'text-purple-400',  label: 'Analyzing' },
  acting:        { bg: 'bg-purple-500/15', text: 'text-purple-400',  label: 'Acting' },
  verifying:     { bg: 'bg-cyan-500/15',   text: 'text-cyan-400',    label: 'Verifying' },
  completed:     { bg: 'bg-emerald-500/15',text: 'text-emerald-400', label: 'Completed' },
  failed:        { bg: 'bg-red-500/15',    text: 'text-red-400',     label: 'Failed' },
};

function isActive(status: string) {
  return status !== 'completed' && status !== 'failed';
}

// Main

export default function Investigations() {
  const navigate = useNavigate();
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const invRes = await apiClient.get<InvestigationSummary[]>('/investigations');
    if (!invRes.error && invRes.data) {
      setInvestigations(invRes.data);
    } else {
      setInvestigations([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh active investigations
  useEffect(() => {
    const hasActive = investigations.some((inv) => isActive(inv.status));
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [investigations, load]);

  const handleDelete = useCallback(async (investigation: InvestigationSummary) => {
    const result = await apiClient.delete(`/investigations/${investigation.id}`);
    if (!result.error) {
      setInvestigations((prev) => prev.filter((inv) => inv.id !== investigation.id));
    }
  }, []);

  const sorted = useMemo(() =>
    [...investigations].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [investigations]
  );

  const activeCount = useMemo(() => investigations.filter((inv) => isActive(inv.status)).length, [investigations]);

  return (
    <div className="min-h-full bg-[var(--color-surface-lowest)]">
      <div className="max-w-4xl mx-auto px-4 py-6 sm:px-6 sm:py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-[var(--color-on-surface)]">Investigations</h1>
            <p className="text-sm text-[var(--color-on-surface-variant)] mt-0.5">
              Diagnose and troubleshoot production issues with AI-driven analysis.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-[var(--color-primary)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            + New Investigation
          </button>
        </div>

        {/* Stats */}
        {investigations.length > 0 && (
          <div className="flex items-center gap-3 mb-5">
            <span className="text-sm text-[var(--color-on-surface)] font-medium">
              {investigations.length} investigation{investigations.length === 1 ? '' : 's'}
            </span>
            {activeCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                {activeCount} active
              </span>
            )}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <span className="inline-block w-6 h-6 border-2 border-[var(--color-outline-variant)] border-t-[var(--color-primary)] rounded-full animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!loading && investigations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-surface-high)] flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-[var(--color-outline)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="9" />
                <polygon points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-sm text-[var(--color-on-surface-variant)] mb-1">No investigations yet</p>
            <p className="text-xs text-[var(--color-outline)] mb-4">Start an investigation to diagnose production issues with AI</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="px-4 py-2 bg-[var(--color-primary)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
            >
              + New Investigation
            </button>
          </div>
        )}

        {/* Investigation list */}
        {!loading && sorted.length > 0 && (
          <div className="space-y-2">
            {sorted.map((inv) => {
              const style = (STATUS_STYLES[inv.status] ?? STATUS_STYLES.planning) as { bg: string; text: string; label: string };
              const active = isActive(inv.status);
              return (
                <div
                  key={inv.id}
                  className="group relative rounded-xl border border-[var(--color-outline-variant)] hover:border-[var(--color-outline)] bg-[var(--color-surface-highest)] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/investigations/${inv.id}`)}
                    className="w-full text-left px-4 py-3.5 pr-14 flex items-center gap-3"
                  >
                    {/* Status indicator */}
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${style.bg}`}>
                      {active ? (
                        <span className={`w-2.5 h-2.5 rounded-full ${style.text.replace('text-', 'bg-')} animate-pulse`} />
                      ) : inv.status === 'completed' ? (
                        <svg className={`w-3.5 h-3.5 ${style.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className={`w-3.5 h-3.5 ${style.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-on-surface)] truncate">{inv.intent}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${style.bg} ${style.text}`}>
                          {style.label}
                        </span>
                        <span className="text-[11px] text-[var(--color-outline)]">{relativeTime(inv.createdAt)}</span>
                      </div>
                    </div>
                  </button>
                  <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center">
                    <button
                      type="button"
                      onClick={() => setDeletingId(inv.id)}
                      className="pointer-events-auto p-1.5 rounded-lg text-[var(--color-outline)] hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <ConfirmDialog
          open={deletingId !== null}
          title="Delete investigation?"
          message="This investigation and all its evidence will be permanently removed."
          onConfirm={() => {
            const investigation = deletingId ? investigations.find((inv) => inv.id === deletingId) : null;
            if (investigation)
              void handleDelete(investigation);
            setDeletingId(null);
          }}
          onCancel={() => setDeletingId(null)}
        />
      </div>
    </div>
  );
}
