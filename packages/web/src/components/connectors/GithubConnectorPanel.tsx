import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../api/client.js';
import {
  getRegistrationStatus,
  getManifest,
  unregister as unregisterGithubApp,
  submitManifestForm,
  syncInstallations,
} from '../../api/github-app-api.js';
import { btnPrimary, btnSecondary } from './styles.js';

export const GITHUB_CONNECT_EVENT_KEY = 'rounds:github-connector-updated';

type RegState =
  | { state: 'loading' }
  | { state: 'unregistered' }
  | { state: 'registered'; slug: string; appId?: number; registeredAt?: string }
  | { state: 'error'; message: string };

export interface GithubConnectorPanelProps {
  canWrite: boolean;
  /** Called after a sync that should refetch the list. */
  onChanged: () => void;
  /** True when at least one github connector is already active for this
   *  org. When set, the "Connect to GitHub" button hides (the user is
   *  already connected) — only Sync / Re-register / Install on another
   *  org are exposed. */
  hasActiveConnector?: boolean;
}

/**
 * GitHub-specific detail panel. Replaces the "edit config" flow with the
 * registration / install / sync UX since GitHub auth is OAuth-shaped.
 */
export function GithubConnectorPanel({
  canWrite,
  onChanged,
  hasActiveConnector = false,
}: GithubConnectorPanelProps): React.ReactElement {
  const [reg, setReg] = useState<RegState>({ state: 'loading' });
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const popupRef = useRef<number | null>(null);

  const refreshRegistration = useCallback(async () => {
    setReg({ state: 'loading' });
    const res = await getRegistrationStatus();
    if ('error' in res) {
      setReg({ state: 'error', message: res.error });
      return;
    }
    if (res.registered && res.slug) {
      setReg({
        state: 'registered',
        slug: res.slug,
        ...(res.appId !== undefined ? { appId: res.appId } : {}),
        ...(res.registeredAt !== undefined ? { registeredAt: res.registeredAt } : {}),
      });
    } else {
      setReg({ state: 'unregistered' });
    }
  }, []);

  useEffect(() => {
    void refreshRegistration();
  }, [refreshRegistration]);

  const syncAndReload = useCallback(async (showEmpty: boolean) => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await syncInstallations();
      if ('error' in res) {
        setBanner({ kind: 'err', message: res.error });
        return;
      }
      const count = res.created.length + res.refreshed.length;
      if (count > 0) {
        setBanner({
          kind: 'ok',
          message: res.created.length > 0
            ? `GitHub connector created for ${res.created.map((c) => c.owner).join(', ')}`
            : 'GitHub connector refreshed',
        });
      } else if (showEmpty) {
        setBanner({ kind: 'err', message: 'No GitHub App installations found for this app yet.' });
      }
      onChanged();
    } finally {
      setSyncing(false);
    }
  }, [onChanged, syncing]);

  useEffect(() => {
    const refresh = () => {
      void syncAndReload(false);
      void refreshRegistration();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === GITHUB_CONNECT_EVENT_KEY) refresh();
    };
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      if (popupRef.current !== null) {
        window.clearInterval(popupRef.current);
        popupRef.current = null;
      }
    };
  }, [refreshRegistration, syncAndReload]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setBanner(null);
    const res = await apiClient.get<{ url: string }>('/connectors/github/install-url');
    setConnecting(false);
    if (res.error) {
      setBanner({ kind: 'err', message: res.error.message ?? 'GitHub App is not registered.' });
      return;
    }
    const popup = window.open(res.data.url, '_blank', 'noopener');
    if (!popup) {
      setBanner({ kind: 'err', message: 'Browser blocked the popup. Allow popups and try again.' });
      return;
    }
    if (popupRef.current !== null) window.clearInterval(popupRef.current);
    popupRef.current = window.setInterval(() => {
      if (!popup.closed) return;
      if (popupRef.current !== null) {
        window.clearInterval(popupRef.current);
        popupRef.current = null;
      }
      void syncAndReload(false);
      void refreshRegistration();
    }, 1000);
  }, [refreshRegistration, syncAndReload]);

  const handleRegister = useCallback(async () => {
    setRegistering(true);
    setBanner(null);
    const res = await getManifest();
    setRegistering(false);
    if ('error' in res) {
      setBanner({ kind: 'err', message: res.error });
      return;
    }
    const out = submitManifestForm(res);
    if (!out.ok && out.reason === 'popup-blocked') {
      setBanner({ kind: 'err', message: 'Browser blocked the popup. Allow popups and click Register again.' });
    }
  }, []);

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-[var(--color-on-surface)]">GitHub App</h3>

      {banner && (
        <div
          className={`rounded-md px-3 py-2 text-xs ${
            banner.kind === 'ok'
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border border-error/30 bg-error/10 text-error'
          }`}
          role={banner.kind === 'err' ? 'alert' : undefined}
        >
          {banner.message}
        </div>
      )}

      {reg.state === 'loading' && (
        <p className="text-xs text-[var(--color-on-surface-variant)]">Checking GitHub App registration…</p>
      )}
      {reg.state === 'error' && <p className="text-xs text-error">{reg.message}</p>}

      {reg.state === 'unregistered' && (
        <div className="space-y-3">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            GitHub integration requires a one-time setup. Click below to create a "Rounds" GitHub App on your account.
          </div>
          <button type="button" disabled={!canWrite || registering} className={btnPrimary} onClick={() => void handleRegister()}>
            {registering ? 'Preparing…' : 'Register Rounds GitHub App'}
          </button>
        </div>
      )}

      {reg.state === 'registered' && (
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-on-surface-variant)]">
            {hasActiveConnector
              ? 'This org is connected to GitHub. Use Sync to refresh repo access after installing the App on additional repos, or Install on another org to extend access.'
              : 'Authorize the Rounds GitHub App on your org. Repos you select become accessible to investigations and remediation plans.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canWrite || connecting}
              className={hasActiveConnector ? btnSecondary : btnPrimary}
              onClick={() => void handleConnect()}
            >
              {connecting
                ? 'Opening…'
                : hasActiveConnector
                  ? 'Install on another org'
                  : 'Connect to GitHub'}
            </button>
            <button type="button" disabled={!canWrite || syncing} className={btnSecondary} onClick={() => void syncAndReload(true)}>
              {syncing ? 'Syncing…' : 'Sync installed app'}
            </button>
            <button
              type="button"
              disabled={!canWrite}
              className={btnSecondary}
              onClick={async () => {
                const r = await unregisterGithubApp();
                if ('error' in r) {
                  setBanner({ kind: 'err', message: r.error });
                  return;
                }
                await refreshRegistration();
              }}
            >
              Re-register
            </button>
          </div>
          <div className="text-[11px] text-[var(--color-on-surface-variant)]">
            Rounds GitHub App: '{reg.slug}'
            {reg.registeredAt ? ` (registered ${reg.registeredAt})` : ''}
          </div>
        </div>
      )}
    </section>
  );
}

export default GithubConnectorPanel;
