/**
 * Frontend helpers for the GitHub App registration/install flow.
 *
 * The manifest flow goes through GitHub: we fetch a JSON manifest from the
 * backend, then auto-submit a POSTed `<form>` to
 * `https://github.com/settings/apps/new?state=...`. GitHub then redirects
 * back to `/api/connectors/github/manifest-callback` which persists the
 * App credentials and bounces the user to `/settings?github=registered`.
 */

import { apiClient } from './rest-api.js';

export interface RegistrationStatus {
  registered: boolean;
  slug?: string;
  appId?: number;
  registeredAt?: string;
}

export interface ManifestPayload {
  manifestUrl: string;
  state: string;
  manifest: string;
}

export interface SyncInstallationsResult {
  ok: boolean;
  created: Array<{ connectorId: string; owner: string; installationId: string }>;
  refreshed: Array<{ connectorId: string; owner: string; installationId: string }>;
  errors?: Array<{ installationId: string; owner: string; message: string }>;
}

export async function getRegistrationStatus(): Promise<RegistrationStatus | { error: string }> {
  const res = await apiClient.get<RegistrationStatus>('/connectors/github/registration-status');
  if (res.error) return { error: res.error.message ?? 'Failed to load registration status' };
  return res.data;
}

export async function getManifest(): Promise<ManifestPayload | { error: string }> {
  const res = await apiClient.get<ManifestPayload>('/connectors/github/manifest');
  if (res.error) return { error: res.error.message ?? 'Failed to load manifest' };
  return res.data;
}

export async function unregister(): Promise<{ ok: boolean } | { error: string }> {
  const res = await apiClient.post<{ ok: boolean }>('/connectors/github/unregister', {});
  if (res.error) return { error: res.error.message ?? 'Failed to unregister' };
  return res.data;
}

export async function syncInstallations(): Promise<SyncInstallationsResult | { error: string }> {
  const res = await apiClient.post<SyncInstallationsResult>('/connectors/github/sync-installations', {});
  if (res.error) return { error: res.error.message ?? 'Failed to sync GitHub installations' };
  return res.data;
}

/**
 * Build and submit the auto-POST form to GitHub's manifest-creation page.
 * GitHub requires a `POST` with the manifest in the body; a normal redirect
 * won't work.
 */
/**
 * Open the manifest POST in a new tab. Returns:
 *   - { ok: true }                  — popup opened, manifest submitted
 *   - { ok: false, popupBlocked }   — browser blocked the popup; caller
 *                                     should surface "allow popups" hint
 *
 * We deliberately do NOT fall back to same-tab navigation when blocked,
 * because that drags the operator out of Settings unexpectedly. Let them
 * unblock popups for this site and retry.
 */
export function submitManifestForm(
  payload: ManifestPayload,
): { ok: true } | { ok: false; reason: 'popup-blocked' } {
  // noopener so the new tab can't navigate the opener (no `window.opener`),
  // which is what was causing the parent Settings tab to also flip.
  // Note: 'noreferrer' breaks document.write on some browsers — use only noopener.
  const tab = window.open('about:blank', '_blank', 'noopener');
  if (!tab) return { ok: false, reason: 'popup-blocked' };
  const targetDoc = tab.document;
  if (!targetDoc) {
    try { tab.close(); } catch { /* ignore */ }
    return { ok: false, reason: 'popup-blocked' };
  }
  targetDoc.open();
  const action = `${payload.manifestUrl}?state=${encodeURIComponent(payload.state)}`;
  const manifestEscaped = payload.manifest
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  targetDoc.write(`<!doctype html><html><body><form id="m" method="POST" action="${action}"><input type="hidden" name="manifest" value="${manifestEscaped}"/></form><script>document.getElementById('m').submit();</script></body></html>`);
  targetDoc.close();
  return { ok: true };
}
