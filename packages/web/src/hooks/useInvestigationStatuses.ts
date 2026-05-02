import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import type { Investigation } from '../api/types.js';
import {
  IN_PROGRESS_INVESTIGATION_STATUSES,
  nextPollIntervalMs,
} from '../pages/alerts-investigation-status.js';

/**
 * Polls /api/investigations/:id for each id in `ids` so the Alerts page can
 * surface live status next to each rule. Cadence is 5s while any tracked
 * investigation is in progress, 30s otherwise, and pauses when the document
 * is hidden.
 */
export function useInvestigationStatuses(ids: string[]): Map<string, Investigation> {
  const [statuses, setStatuses] = useState<Map<string, Investigation>>(new Map());
  // Stable string key so the effect only re-runs when the set of ids changes.
  const key = [...ids].sort().join(',');
  // Snapshot the latest list inside a ref so the effect closure does not
  // capture stale ids when the key happens to be equal.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  useEffect(() => {
    if (!key) {
      setStatuses(new Map());
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      const visible =
        typeof document === 'undefined' || document.visibilityState !== 'hidden';
      if (!visible) {
        timer = setTimeout(tick, nextPollIntervalMs({ anyActive: false, visible: false }));
        return;
      }
      const current = idsRef.current;
      const results = await Promise.all(
        current.map(async (id) => {
          const res = await apiClient.get<Investigation>(`/investigations/${id}`);
          return res.error ? null : res.data;
        }),
      );
      if (cancelled) return;
      setStatuses(() => {
        const next = new Map<string, Investigation>();
        for (const inv of results) {
          if (inv) next.set(inv.id, inv);
        }
        return next;
      });
      const anyActive = results.some(
        (inv) => inv != null && IN_PROGRESS_INVESTIGATION_STATUSES.has(inv.status),
      );
      timer = setTimeout(tick, nextPollIntervalMs({ anyActive, visible: true }));
    }

    void tick();

    const onVisibility = () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key]);

  return statuses;
}
