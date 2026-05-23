import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';
import { useAuth } from '../../contexts/AuthContext.js';
import ConnectorList from './ConnectorList.js';
import ConnectorDetail from './ConnectorDetail.js';
import AddConnectorPanel from './AddConnectorPanel.js';
import { GITHUB_CONNECT_EVENT_KEY } from './GithubConnectorPanel.js';
import type { ConnectorRow } from './types.js';

export interface ConnectorsPanelProps {
  canWrite: boolean;
}

/**
 * Two-pane Connectors UI. The Settings page's left tab rail acts as the
 * leftmost column (Skills / Connectors / …); this panel renders the middle
 * (list) and right (detail) panes.
 */
export function ConnectorsPanel({ canWrite }: ConnectorsPanelProps): React.ReactElement {
  const { user } = useAuth();
  const orgId = user?.orgId ?? '';

  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [githubBanner, setGithubBanner] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiClient.get<{ connectors: ConnectorRow[] }>('/connectors');
    if (res.error) {
      setError(res.error.message ?? 'Failed to load connectors');
      setConnectors([]);
    } else {
      const list = res.data.connectors ?? [];
      setConnectors(list);
      setSelectedId((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // One-shot URL-param read on mount: surfaces the GitHub OAuth callback
  // outcome as a banner, then clears the param so a refresh doesn't repeat
  // the banner.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get('github');
    if (!status) return;
    if (status === 'connected') {
      setGithubBanner({ kind: 'ok', message: 'GitHub connector created' });
      localStorage.setItem(GITHUB_CONNECT_EVENT_KEY, String(Date.now()));
    } else if (status === 'registered') {
      setGithubBanner({ kind: 'ok', message: 'Rounds GitHub App registered. You can now connect repos.' });
      localStorage.setItem(GITHUB_CONNECT_EVENT_KEY, String(Date.now()));
    } else if (status === 'error') {
      setGithubBanner({ kind: 'err', message: params.get('reason') ?? 'GitHub connection failed' });
    }
    params.delete('github');
    params.delete('reason');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
  }, []);

  const selected = selectedId ? connectors.find((c) => c.id === selectedId) ?? null : null;

  const handleSelect = (id: string) => {
    setCreating(false);
    setSelectedId(id);
  };

  const handleAddClick = () => {
    setCreating(true);
    setSelectedId(null);
  };

  const handleCreated = (newId: string) => {
    setCreating(false);
    void load().then(() => setSelectedId(newId));
  };

  const handleSaved = () => {
    void load();
  };

  const handleDeleted = () => {
    setSelectedId(null);
    void load();
  };

  return (
    <div className="flex h-full flex-col">
      {githubBanner && (
        <div
          className={`m-4 mb-0 rounded-lg px-4 py-3 text-sm flex items-center justify-between gap-3 ${
            githubBanner.kind === 'ok'
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
              : 'border border-error/30 bg-error/10 text-error'
          }`}
          role={githubBanner.kind === 'err' ? 'alert' : undefined}
        >
          <span>{githubBanner.kind === 'err' ? `GitHub: ${githubBanner.message}` : githubBanner.message}</span>
          <button type="button" className="text-xs underline" onClick={() => setGithubBanner(null)}>
            dismiss
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
      {/* Middle pane: list */}
      <aside className="w-64 shrink-0 border-r border-[var(--color-outline-variant)]/30 bg-[var(--color-surface-lowest)]">
        <ConnectorList
          connectors={connectors}
          selectedId={selectedId}
          onSelect={handleSelect}
          onAddClick={handleAddClick}
          loading={loading}
          canWrite={canWrite}
          creating={creating}
        />
      </aside>

      {/* Right pane: detail */}
      <main className="flex-1 min-w-0">
        {error && !creating && (
          <div className="m-6 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
            {error}
          </div>
        )}

        {creating ? (
          <AddConnectorPanel
            canWrite={canWrite}
            onCreated={handleCreated}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <ConnectorDetail
            key={selected.id}
            connector={selected}
            canWrite={canWrite}
            orgId={orgId}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-[var(--color-on-surface)]">
                {loading ? 'Loading connectors…' : 'No connector selected'}
              </p>
              {!loading && (
                <p className="mt-1 text-xs text-[var(--color-on-surface-variant)]">
                  Pick one from the list, or click “+ Add connector” to create one.
                </p>
              )}
            </div>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}

export default ConnectorsPanel;
