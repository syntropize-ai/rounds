/**
 * AISuggestionsInbox — Wave 2 / step 3.
 *
 * The single inbox on Home for AI-generated proposals. Why one inbox and
 * not 6 notification channels: see the design doc — 6 channels become
 * spam, one inbox stays glanceable.
 *
 * UI states:
 *   - loading      → render nothing (we render alongside other Home cards,
 *                    so a spinner would just flash)
 *   - empty        → "Nothing to suggest right now. Rounds will check
 *                    again later."
 *   - has rows     → list rows with Accept / Snooze / Dismiss buttons
 *
 * Optimistic updates: clicking Accept/Snooze/Dismiss removes the row
 * locally before the request resolves. If the server returns an error we
 * refetch — we don't try to put the row back surgically because the inbox
 * is small and a refetch is cheap.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';

interface AiSuggestion {
  id: string;
  kind: string;
  title: string;
  body: string;
  actionKind: string | null;
  state: string;
}

interface AcceptResult {
  suggestion: AiSuggestion;
  action: { kind: 'navigate'; url: string } | { kind: 'message'; message: string } | null;
}

function actionLabel(kind: string | null): string {
  switch (kind) {
    case 'create_dashboard':
      return 'Yes, create';
    case 'archive_resources':
      return 'Review';
    case 'merge_dashboards':
      return 'Compare';
    default:
      return 'Accept';
  }
}

export function AISuggestionsInbox(): JSX.Element | null {
  const [items, setItems] = useState<AiSuggestion[] | null>(null);
  const [snoozeOpenFor, setSnoozeOpenFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiClient.get<{ suggestions: AiSuggestion[] }>('/suggestions');
    if (!res.error && res.data?.suggestions) {
      setItems(res.data.suggestions);
    } else if (!res.error) {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const optimisticRemove = useCallback((id: string) => {
    setItems((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
  }, []);

  const handleAccept = useCallback(
    async (s: AiSuggestion) => {
      optimisticRemove(s.id);
      const res = await apiClient.post<AcceptResult>(`/suggestions/${s.id}/accept`, {});
      if (res.error) {
        void refresh();
        return;
      }
      const action = res.data?.action;
      if (action && action.kind === 'navigate') {
        window.location.assign(action.url);
      }
    },
    [optimisticRemove, refresh],
  );

  const handleSnooze = useCallback(
    async (id: string, days: 1 | 7) => {
      setSnoozeOpenFor(null);
      optimisticRemove(id);
      const res = await apiClient.post(`/suggestions/${id}/snooze`, { days });
      if (res.error) void refresh();
    },
    [optimisticRemove, refresh],
  );

  const handleDismiss = useCallback(
    async (id: string) => {
      optimisticRemove(id);
      const res = await apiClient.post(`/suggestions/${id}/dismiss`, {});
      if (res.error) void refresh();
    },
    [optimisticRemove, refresh],
  );

  const handleSnoozeAll = useCallback(async () => {
    setItems([]);
    const res = await apiClient.post('/suggestions/snooze-all', { days: 7 });
    if (res.error) void refresh();
  }, [refresh]);

  if (items === null) return null;

  return (
    <section
      className="rounded-lg border border-outline-variant bg-surface-container/40 p-4"
      aria-label="AI suggestions"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
          AI Suggestions {items.length > 0 ? `(${items.length})` : ''}
        </h2>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          Nothing to suggest right now. Rounds will check again later.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((s) => (
            <li
              key={s.id}
              className="rounded-md border border-outline-variant/60 bg-surface-lowest p-3"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden className="text-base">
                  💡
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-on-surface">{s.title}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => void handleAccept(s)}
                      className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-primary hover:bg-primary/20"
                    >
                      {actionLabel(s.actionKind)}
                    </button>

                    <div className="relative">
                      <button
                        type="button"
                        onClick={() =>
                          setSnoozeOpenFor((cur) => (cur === s.id ? null : s.id))
                        }
                        className="rounded-full border border-outline-variant px-3 py-1 text-on-surface-variant hover:bg-surface-container"
                      >
                        Snooze
                      </button>
                      {snoozeOpenFor === s.id && (
                        <div
                          role="menu"
                          className="absolute z-10 mt-1 flex flex-col gap-1 rounded-md border border-outline-variant bg-surface p-1 shadow"
                        >
                          <button
                            type="button"
                            onClick={() => void handleSnooze(s.id, 1)}
                            className="px-3 py-1 text-left text-xs text-on-surface hover:bg-surface-container"
                          >
                            1 day
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSnooze(s.id, 7)}
                            className="px-3 py-1 text-left text-xs text-on-surface hover:bg-surface-container"
                          >
                            1 week
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleDismiss(s.id)}
                      className="rounded-full border border-outline-variant px-3 py-1 text-on-surface-variant hover:bg-surface-container"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void handleSnoozeAll()}
            className="text-xs text-on-surface-variant hover:text-on-surface"
          >
            Snooze all for a week
          </button>
        </div>
      )}
    </section>
  );
}
