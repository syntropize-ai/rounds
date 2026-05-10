import { useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';

export interface InstanceDatasource {
  id: string;
  type: string;
  name: string;
  url?: string;
  config?: { url?: string; label?: string; environment?: string; cluster?: string };
  environment?: string;
  cluster?: string;
  label?: string;
  isDefault?: boolean;
  apiKey?: string;
  username?: string;
  password?: string;
}

/**
 * Shared id → InstanceDatasource lookup for panel headers and other UI that
 * needs to render a datasource's name without each component independently
 * fetching `/api/connectors`.
 *
 * Implementation: a single module-level promise dedupes the in-flight fetch
 * across N concurrent callers, and a `version` counter (bumped via the
 * `connectors:changed` window event) forces a refetch whenever Settings
 * mutates the list.
 */

let inflight: Promise<Map<string, InstanceDatasource>> | null = null;
let cached: Map<string, InstanceDatasource> | null = null;
let cachedVersion = 0;

function fetchOnce(): Promise<Map<string, InstanceDatasource>> {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await apiClient.get<{ connectors: InstanceDatasource[] }>('/connectors');
    const map = new Map<string, InstanceDatasource>();
    if (!res.error && res.data?.connectors) {
      for (const connector of res.data.connectors) {
        map.set(connector.id, {
          ...connector,
          url: connector.url ?? connector.config?.url,
          label: connector.label ?? connector.config?.label,
          environment: connector.environment ?? connector.config?.environment,
          cluster: connector.cluster ?? connector.config?.cluster,
        });
      }
    }
    cached = map;
    return map;
  })();
  // Always clear inflight so a subsequent refresh can re-fetch.
  void inflight.finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Bump from Settings (or anywhere else that mutates datasources) so consumers
 *  reload their lookup. The hook also auto-listens for this internally. */
export function notifyConnectorsChanged(): void {
  cachedVersion += 1;
  cached = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('connectors:changed'));
  }
}

export function useDatasourceLookup(): Map<string, InstanceDatasource> {
  const [map, setMap] = useState<Map<string, InstanceDatasource>>(() => cached ?? new Map());
  const [, setTick] = useState(cachedVersion);

  useEffect(() => {
    let alive = true;
    void fetchOnce().then((m) => {
      if (alive) setMap(m);
    });

    const onChange = () => {
      // Force a fresh fetch — the cache was already invalidated by
      // notifyConnectorsChanged, but a separate dispatcher (another tab,
      // future SSE) might fire the event without touching module state.
      cached = null;
      setTick((n) => n + 1);
      void fetchOnce().then((m) => {
        if (alive) setMap(m);
      });
    };
    window.addEventListener('connectors:changed', onChange);
    return () => {
      alive = false;
      window.removeEventListener('connectors:changed', onChange);
    };
  }, []);

  return map;
}
