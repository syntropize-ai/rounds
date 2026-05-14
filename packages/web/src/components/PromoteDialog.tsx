/**
 * PromoteDialog — Wave 2 step 1.
 *
 * Two-phase flow against /api/resources/:kind/:id/promote:
 *   1. Mount: POST without `?confirmed=true` to fetch the preview payload.
 *   2. Confirm: POST with `?confirmed=true` after the user picks a target.
 *
 * The user picks `targetFolderUid` via <FolderPicker>, which is filtered
 * server-side (via /api/folders?kind=shared) so personal workspaces never
 * appear as a destination. The button copy mirrors the spec:
 *   "Promote <name> to team?" → [Cancel] [Confirm promote]
 *
 * Wiring: drop this dialog onto any list row that exposes a draft. The
 * MyWorkspace page (planned Wave 1 PR-C) is the canonical home; the
 * existing Dashboards / Alerts list pages can adopt it incrementally.
 */

import { useEffect, useState } from 'react';
import FolderPicker from './FolderPicker';

export type PromoteResourceKind = 'dashboard' | 'alert_rule';

export interface PromoteDialogProps {
  open: boolean;
  kind: PromoteResourceKind;
  id: string;
  /** Display name for the title (e.g. dashboard.title). */
  resourceName: string;
  onCancel: () => void;
  onSuccess: (result: PromoteResultPayload) => void;
}

interface PromotePreview {
  kind: PromoteResourceKind;
  id: string;
  resourceName: string;
  currentFolderUid: string | null;
  currentFolderTitle: string | null;
  targetFolderUid: string;
  targetFolderTitle: string;
  visibility: string;
  ownerUserId: string;
  ownerChange?: { from: string; to: string };
  confirmationMode: 'strong_user_confirm';
}

export interface PromoteResultPayload {
  kind: PromoteResourceKind;
  id: string;
  fromFolderUid: string | null;
  toFolderUid: string;
  ownerChange?: { from: string; to: string };
}

async function callPromote(
  kind: PromoteResourceKind,
  id: string,
  body: { targetFolderUid: string; owner?: string; description?: string },
  confirmed: boolean,
): Promise<{ kind: 'preview'; preview: PromotePreview } | { kind: 'result'; result: PromoteResultPayload }> {
  const url = `/api/resources/${kind}/${id}/promote${confirmed ? '?confirmed=true' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `request failed: ${res.status}`);
  }
  return res.json();
}

export default function PromoteDialog({
  open,
  kind,
  id,
  resourceName,
  onCancel,
  onSuccess,
}: PromoteDialogProps): React.ReactElement | null {
  const [targetFolderUid, setTargetFolderUid] = useState<string>('');
  const [preview, setPreview] = useState<PromotePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch preview whenever the target changes. The body itself is the
  // single source of truth — no separate GET endpoint needed.
  useEffect(() => {
    if (!open || !targetFolderUid) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    callPromote(kind, id, { targetFolderUid }, false)
      .then((data) => {
        if (cancelled || data.kind !== 'preview') return;
        setPreview(data.preview);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, id, targetFolderUid]);

  if (!open) return null;

  const handleConfirm = async (): Promise<void> => {
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      const data = await callPromote(kind, id, { targetFolderUid: preview.targetFolderUid }, true);
      if (data.kind === 'result') {
        onSuccess(data.result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-[var(--color-surface-highest)] border border-[var(--color-outline-variant)] rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6">
          <h3 className="text-base font-semibold text-[var(--color-on-surface)] mb-1">
            Promote &ldquo;{resourceName}&rdquo; to team?
          </h3>
          <hr className="border-[var(--color-outline-variant)] my-3" />

          <div className="space-y-3 text-sm text-[var(--color-on-surface-variant)]">
            <div>
              <label className="block text-xs uppercase tracking-wide mb-1">Promote to</label>
              <FolderPicker
                kind="shared"
                value={targetFolderUid}
                onChange={setTargetFolderUid}
              />
            </div>

            {loading && <div>Loading preview…</div>}
            {error && (
              <div className="text-[var(--color-error)] text-sm">{error}</div>
            )}
            {preview && !loading && (
              <>
                <div>
                  <span className="font-medium text-[var(--color-on-surface)]">Will be visible to:</span>{' '}
                  {preview.targetFolderTitle}
                </div>
                <div>
                  <span className="font-medium text-[var(--color-on-surface)]">Owner:</span>{' '}
                  {preview.ownerChange ? `${preview.ownerChange.from} → ${preview.ownerChange.to}` : preview.ownerUserId}
                </div>
                <div>
                  <span className="font-medium text-[var(--color-on-surface)]">Permissions:</span>{' '}
                  team can read/edit
                </div>
                <div className="text-xs">{preview.visibility}</div>
              </>
            )}
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)] border border-[var(--color-outline-variant)] rounded-lg hover:bg-[var(--color-surface-high)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!preview || loading}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-[var(--color-primary)] text-white disabled:opacity-50"
            >
              Confirm promote
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
