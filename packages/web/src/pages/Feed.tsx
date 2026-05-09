import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client.js';
import FeedItem from '../components/FeedItem.js';
import Skeleton from '../components/Skeleton.js';
import type { FeedItemData } from '../components/FeedItem.js';
import type { FeedSeverity } from '../components/FeedItem.js';

interface FeedPage {
  items: FeedItemData[];
  total: number;
  page: number;
  limit: number;
}

const PAGE_LIMIT = 20;

const SEVERITY_LEVELS: FeedSeverity[] = ['critical', 'high', 'medium', 'low'];

// Filter buttons reuse the severity tokens; the `active` variant uses the
// solid token color as background, the `inactive` variant the soft 10%
// fill. `low` falls back to a neutral surface treatment.
const SEVERITY_PILL_STYLES: Record<
  FeedSeverity,
  { active: string; inactive: string }
> = {
  critical: {
    active: 'bg-severity-critical text-white',
    inactive: 'bg-severity-critical/10 text-severity-critical hover:bg-severity-critical/20',
  },
  high: {
    active: 'bg-severity-high text-white',
    inactive: 'bg-severity-high/10 text-severity-high hover:bg-severity-high/20',
  },
  medium: {
    active: 'bg-severity-medium text-white',
    inactive: 'bg-severity-medium/10 text-severity-medium hover:bg-severity-medium/20',
  },
  low: {
    active: 'bg-[var(--color-on-surface-variant)] text-[var(--color-surface-low)]',
    inactive: 'bg-[var(--color-surface-high)] text-[var(--color-on-surface-variant)] hover:bg-[var(--color-outline-variant)]',
  },
};

export default function Feed() {
  const [items, setItems] = useState<FeedItemData[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState<FeedSeverity | ''>('');
  const [statusFilter, setStatusFilter] = useState<'read' | 'unread' | ''>('unread');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFeed = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
    if (severity) params.set('severity', severity);
    if (statusFilter) params.set('status', statusFilter);

    const res = await apiClient.get<FeedPage>(`/feed?${params.toString()}`);
    setLoading(false);

    if (res.error) {
      setError(res.error.message);
      return;
    }

    setItems(res.data.items);
    setTotal(res.data.total);
  }, [page, severity, statusFilter]);

  useEffect(() => {
    void fetchFeed();
  }, [fetchFeed]);

  useEffect(() => {
    setPage(1);
  }, [severity, statusFilter]);

  const handleMarkRead = useCallback(async (id: string) => {
    const res = await apiClient.post<FeedItemData>(`/feed/${id}/read`, {});
    if (!res.error) {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: 'read' } : item))
      );
    }
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    const unreadIds = items.filter((i) => i.status === 'unread').map((i) => i.id);
    await Promise.all(unreadIds.map((id) => apiClient.post(`/feed/${id}/read`, {})));
    setItems((prev) =>
      prev.map((i) => ({ ...i, status: 'read' as const }))
    );
  }, [items]);

  // Count items by severity (for current page for simplicity)
  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const item of items) {
      counts[item.severity] = (counts[item.severity] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const unreadCount = items.filter((i) => i.status === 'unread').length;

  return (
    <div className="min-h-full bg-[var(--color-surface-lowest)]">
      <div className="max-w-3xl mx-auto px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-[var(--color-on-surface)]">Feed</h1>
            <p className="text-xs text-[var(--color-outline)] mt-0.5">
              {total} event{total === 1 ? '' : 's'} {unreadCount > 0 ? `• ${unreadCount} unread` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  void handleMarkAllRead();
                }}
                className="text-xs text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)] px-3 py-1.5 rounded-lg border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] transition-colors"
              >
                Mark all read
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                void fetchFeed();
              }}
              disabled={loading}
              className="p-1.5 rounded-lg text-[var(--color-outline)] hover:text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] transition-colors disabled:opacity-40"
              title="Refresh"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m14.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0A8.003 8.003 0 015.163 13M15 15h5" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <button
            type="button"
            onClick={() => setSeverity('')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              severity === ''
                ? 'bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)]'
                : 'bg-[var(--color-surface-high)] text-[var(--color-on-surface-variant)] hover:bg-[var(--color-outline-variant)]'
            }`}
          >
            All
          </button>

          {SEVERITY_LEVELS.map((level) => {
            const count = severityCounts[level] ?? 0;
            const isActive = severity === level;
            const styles = SEVERITY_PILL_STYLES[level];
            return (
              <button
                key={level}
                type="button"
                onClick={() => setSeverity(isActive ? '' : level)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                  isActive ? styles.active : styles.inactive
                }`}
              >
                {level}
                {count > 0 && <span className="ml-1.5 opacity-80">{count}</span>}
              </button>
            );
          })}

          <div className="flex-1" />

          <div className="flex bg-[var(--color-surface-highest)] rounded-lg border border-[var(--color-outline-variant)]">
            {([
              ['', 'All'],
              ['unread', 'Unread'],
              ['read', 'Read'],
            ] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setStatusFilter(val as typeof statusFilter)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === val
                    ? 'bg-[var(--color-surface-high)] text-[var(--color-on-surface)]'
                    : 'text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-severity-critical/10 border border-severity-critical/20 text-sm text-severity-critical">
            {error}
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="space-y-3" data-testid="feed-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} variant="card" />
            ))}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[var(--color-surface-highest)] border border-[var(--color-outline-variant)] flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-[var(--color-outline)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M3 7h12M3 17h8" />
              </svg>
            </div>
            <p className="text-sm text-[var(--color-on-surface-variant)] mb-1">No events found</p>
            <p className="text-xs text-[var(--color-outline)]">
              {severity || statusFilter
                ? 'Try changing the filters above'
                : 'Events will appear here when anomalies are detected'}
            </p>
          </div>
        )}

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => (
              <FeedItem key={item.id} item={item} onMarkRead={handleMarkRead} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-[var(--color-outline-variant)]">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-outline-variant)] text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-on-surface)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>

            <span className="text-xs text-[var(--color-outline)]">
              Page {page} / {totalPages}
            </span>

            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-outline-variant)] text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-on-surface)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
