import React from 'react';
import { apiClient } from '../../api/client.js';

export interface UserSearchResult {
  userId: string;
  login: string;
  email: string;
  name?: string;
}

/** Shape returned by /api/org/users — keep keys Grafana-compatible. */
interface OrgUserDTO {
  userId: string;
  login: string;
  email: string;
  name?: string;
}

interface Props {
  onSelect: (user: UserSearchResult) => void;
  debounceMs?: number;
}

/**
 * Debounced user picker. Queries `GET /api/org/users?query=...`.
 *
 * License hygiene: debounce + open-on-focus pattern is commodity UX; no
 * Grafana frontend code referenced.
 */
export function UserSearchField({ onSelect, debounceMs = 250 }: Props): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<UserSearchResult[]>([]);
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
        .get<OrgUserDTO[] | { users?: OrgUserDTO[] }>(
          `/org/users?query=${encodeURIComponent(query.trim())}`,
        )
        .then((res) => {
          if (res.error) {
            setResults([]);
            return;
          }
          const raw = Array.isArray(res.data)
            ? res.data
            : Array.isArray(res.data?.users)
              ? (res.data.users as OrgUserDTO[])
              : [];
          setResults(
            raw.map((u) => ({ userId: u.userId, login: u.login, email: u.email, name: u.name })),
          );
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
        placeholder="Search users by login or email…"
        aria-label="Search users"
        className="w-full bg-surface-high text-on-surface text-sm rounded-md px-2 py-1.5 border border-outline focus:ring-1 focus:ring-primary outline-none"
      />
      {open && (results.length > 0 || loading) ? (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-60 overflow-y-auto z-10 bg-surface-highest border border-outline-variant rounded-md shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-xs text-on-surface-variant">Searching…</div>
          ) : (
            results.map((u) => (
              <button
                key={u.userId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(u);
                  setQuery('');
                  setResults([]);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm text-on-surface hover:bg-primary/10 transition-colors"
              >
                <div className="font-medium">{u.login}</div>
                <div className="text-xs text-on-surface-variant">{u.email}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
