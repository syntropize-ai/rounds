import React from 'react';
import { apiClient } from '../../api/client.js';

export interface TeamSearchResult {
  teamId: string;
  name: string;
}

/** /api/teams/search response element. */
interface TeamSearchDTO {
  id: string;
  name: string;
}

interface Props {
  onSelect: (team: TeamSearchResult) => void;
  debounceMs?: number;
}

/**
 * Debounced team picker. Queries `GET /api/teams/search?query=...`.
 *
 * License hygiene: generic async-search dropdown; not adapted from Grafana JS.
 */
export function TeamSearchField({ onSelect, debounceMs = 250 }: Props): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<TeamSearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      setLoading(true);
      void apiClient
        .get<TeamSearchDTO[] | { teams?: TeamSearchDTO[] }>(
          `/teams/search?query=${encodeURIComponent(query.trim())}`,
        )
        .then((res) => {
          if (res.error) {
            setResults([]);
            return;
          }
          const raw = Array.isArray(res.data)
            ? res.data
            : Array.isArray(res.data?.teams)
              ? (res.data.teams as TeamSearchDTO[])
              : [];
          setResults(raw.map((t) => ({ teamId: t.id, name: t.name })));
        })
        .finally(() => setLoading(false));
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, debounceMs]);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search teams…"
        aria-label="Search teams"
        className="w-full bg-surface-high text-on-surface text-sm rounded-md px-2 py-1.5 border border-outline focus:ring-1 focus:ring-primary outline-none"
      />
      {open && (results.length > 0 || loading) ? (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-60 overflow-y-auto z-10 bg-surface-highest border border-outline-variant rounded-md shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-xs text-on-surface-variant">Searching…</div>
          ) : (
            results.map((t) => (
              <button
                key={t.teamId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(t);
                  setQuery('');
                  setResults([]);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm text-on-surface hover:bg-primary/10 transition-colors"
              >
                {t.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
