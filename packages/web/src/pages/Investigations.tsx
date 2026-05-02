import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { relativeTime } from '../utils/time.js';
import { getInvestigationStatusStyle } from '../constants/status-styles.js';
import { useAuth } from '../contexts/AuthContext.js';

// Types — matches the summary returned by GET /investigations

interface InvestigationSummary {
  id: string;
  status: string;
  intent: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

// Helpers

function isActive(status: string) {
  return status !== 'completed' && status !== 'failed';
}

// Main

export default function Investigations() {
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  // Backend gates via canonical `investigations:*` actions
  // (packages/api-gateway/src/routes/investigation/router.ts). The legacy
  // singular `investigation:*` fallback was removed once the backend rename
  // landed.
  const canCreateInvestigation = !!user
    && (user.isServerAdmin
      || hasPermission('investigations:create'));
  const canDeleteInvestigation = !!user
    && (user.isServerAdmin
      || hasPermission('investigations:delete')
      || hasPermission('investigations:write'));
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
  const filtered = useMemo(() => {
    if (!search.trim()) return sorted;
    const q = search.trim().toLowerCase();
    return sorted.filter((inv) =>
      inv.intent.toLowerCase().includes(q)
      || inv.status.toLowerCase().includes(q)
      || inv.userId.toLowerCase().includes(q)
    );
  }, [search, sorted]);

  return (
    <div className="flex-1 overflow-y-auto bg-surface-lowest">
      <div className="max-w-5xl mx-auto p-8">
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-on-surface font-[Manrope]">Investigations</h1>
            <p className="mt-1 text-sm text-on-surface-variant">
              Diagnose and troubleshoot production issues with AI-driven analysis.
            </p>
          </div>
          {canCreateInvestigation && (
            <button
              type="button"
              onClick={() => navigate('/')}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary-fixed transition-transform active:scale-95"
            >
              + New Investigation
            </button>
          )}
        </div>

        <div className="mb-6">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search investigations..."
              className="w-full rounded-lg bg-surface-high pl-10 pr-10 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary border-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {loading && (
          <div className="flex justify-center py-16">
            <span className="inline-block h-6 w-6 rounded-full border-2 border-outline border-t-primary animate-spin" />
          </div>
        )}

        {!loading && investigations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-surface-high">
              <svg className="h-7 w-7 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="9" />
                <polygon points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="mb-1 text-sm text-on-surface-variant">No investigations yet</p>
            <p className="text-xs text-[var(--color-outline)]">Start an investigation to diagnose production issues with AI</p>
          </div>
        )}

        {!loading && investigations.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center border border-outline-variant bg-surface-highest py-16 text-center">
            <p className="mb-1 text-sm text-on-surface-variant">No investigations match "{search}"</p>
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-xs text-primary hover:text-primary-container"
            >
              Clear search
            </button>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="space-y-2.5">
            {filtered.map((inv) => {
              const style = getInvestigationStatusStyle(inv.status);
              return (
                <div
                  key={inv.id}
                  className="group relative overflow-hidden border border-outline-variant bg-surface-highest transition-colors hover:border-outline"
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/investigations/${inv.id}`)}
                    className="flex w-full items-center gap-3 px-4 py-3.5 pr-14 text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium text-on-surface">{inv.intent}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.bg} ${style.text}`}>
                          {style.label}
                        </span>
                        <span className="text-[11px] text-[var(--color-outline)]">{relativeTime(inv.createdAt)}</span>
                        <span className="text-[11px] text-[var(--color-outline)]">Updated {relativeTime(inv.updatedAt)}</span>
                      </div>
                    </div>
                  </button>
                  {canDeleteInvestigation && (
                    <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center">
                      <button
                        type="button"
                        onClick={() => setDeletingId(inv.id)}
                        className="pointer-events-auto rounded-lg p-1.5 text-[var(--color-outline)] opacity-0 transition-all hover:bg-error/10 hover:text-error group-hover:opacity-100"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  )}
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
