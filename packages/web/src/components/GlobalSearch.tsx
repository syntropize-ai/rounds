import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';

interface SearchResult {
  type: 'dashboard' | 'investigation' | 'alert' | 'folder' | 'panel';
  id: string;
  title: string;
  subtitle?: string;
  matchField?: string;
  navigateTo: string;
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-primary font-semibold">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  dashboard: {
    label: 'Dashboards', color: 'text-primary bg-primary/10',
    icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z" /></svg>,
  },
  investigation: {
    label: 'Investigations', color: 'text-tertiary bg-tertiary/10',
    icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
  },
  alert: {
    label: 'Alerts', color: 'text-error bg-error/10',
    icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>,
  },
  folder: {
    label: 'Folders', color: 'text-primary bg-primary/10',
    icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>,
  },
  panel: {
    label: 'Panels', color: 'text-secondary bg-secondary/10',
    icon: <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>,
  },
};

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const navigate = useNavigate();

  // Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setOpen(true); }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  useEffect(() => {
    if (open) { setQuery(''); setResults([]); setActiveIdx(0); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void apiClient.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query.trim())}&limit=20`).then((res) => {
        if (!res.error) setResults(res.data.results);
        setLoading(false);
      });
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  useEffect(() => { setActiveIdx(0); }, [results]);

  // Group by type
  const grouped = React.useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const key = r.type;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries());
  }, [results]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && results[activeIdx]) { navigate(results[activeIdx].navigateTo); setOpen(false); }
  }, [results, activeIdx, navigate]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  let globalIdx = -1;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-surface-highest rounded-2xl shadow-2xl w-[560px] max-h-[60vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/20">
          <svg className="w-5 h-5 text-on-surface-variant shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Search dashboards, panels, alerts, folders..."
            className="flex-1 bg-transparent text-on-surface text-sm placeholder:text-on-surface-variant/50 outline-none" />
          {loading && <span className="inline-block w-4 h-4 border-2 border-outline border-t-primary rounded-full animate-spin shrink-0" />}
          <kbd className="text-[10px] text-on-surface-variant bg-surface-high px-1.5 py-0.5 rounded font-mono">ESC</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {!query.trim() && (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-on-surface-variant">Type to search across dashboards, panels, alerts, and folders</p>
              <p className="text-[10px] text-on-surface-variant/50 mt-2">
                <kbd className="bg-surface-high px-1 py-0.5 rounded font-mono">↑↓</kbd> navigate
                <span className="mx-2">·</span>
                <kbd className="bg-surface-high px-1 py-0.5 rounded font-mono">Enter</kbd> open
              </p>
            </div>
          )}

          {query.trim() && !loading && results.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-on-surface-variant">No results for "<span className="text-primary">{query}</span>"</p>
            </div>
          )}

          {grouped.map(([type, items]) => {
            const cfg = TYPE_CONFIG[type];
            return (
              <div key={type}>
                <p className="px-5 py-1.5 text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{cfg?.label ?? type}</p>
                {items.map((r) => {
                  globalIdx++;
                  const idx = globalIdx;
                  const icon = TYPE_CONFIG[r.type];
                  return (
                    <button key={r.id} data-idx={idx} type="button"
                      onClick={() => { navigate(r.navigateTo); setOpen(false); }}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${idx === activeIdx ? 'bg-primary/10' : 'hover:bg-surface-bright'}`}>
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${icon?.color ?? ''}`}>{icon?.icon}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-on-surface truncate">{highlight(r.title, query)}</div>
                        {r.subtitle && (
                          <div className="text-xs text-on-surface-variant truncate mt-0.5">
                            {r.matchField === 'panel' && <span className="text-on-surface-variant/60">in </span>}
                            {r.matchField === 'promql' && <span className="text-on-surface-variant/60">query: </span>}
                            {highlight(r.subtitle, query)}
                          </div>
                        )}
                      </div>
                      {r.matchField && <span className="text-[9px] text-on-surface-variant/50 bg-surface-high px-1.5 py-0.5 rounded shrink-0">{r.matchField}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {results.length > 0 && (
          <div className="px-5 py-2 border-t border-outline-variant/20 text-[10px] text-on-surface-variant/50">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
