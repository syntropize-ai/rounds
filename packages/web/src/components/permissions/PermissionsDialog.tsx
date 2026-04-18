import React from 'react';
import ReactDOM from 'react-dom';
import type { ResourceKind, ResourcePermissionEntry } from '@agentic-obs/common';
import { api } from '../../api/client.js';
import {
  buildSavePayload,
  entryToDraft,
  splitBuckets,
  upsertDraft,
  type DraftDirectEntry,
} from './helpers.js';
import { PermissionRowEditable, PermissionRowInherited } from './PermissionRow.js';
import { AddPermissionFlyout } from './AddPermissionFlyout.js';

export interface PermissionsDialogProps {
  /** Resource kind. Must be one of the four that supports resource permissions. */
  resource: ResourceKind;
  uid: string;
  resourceName: string;
  onClose: () => void;
  /** Optional: fires after a successful save so callers can refetch. */
  onSaved?: () => void;
}

/**
 * Reusable permissions dialog per docs/auth-perm-design/09-frontend.md §T8.7.
 *
 * Fetches the resource's permission list, splits into inherited (read-only)
 * and direct (editable) buckets, lets the user add/remove/change direct
 * grants, and POSTs the full desired state on Save.
 *
 * License hygiene: design semantics are from our design docs and Grafana's
 * public API surface; no Grafana frontend code was read or ported. UX
 * primitives (modal + scrim + list) are idiomatic openobs.
 */
export function PermissionsDialog(props: PermissionsDialogProps): React.ReactElement | null {
  const { resource, uid, resourceName, onClose, onSaved } = props;

  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const [inherited, setInherited] = React.useState<ResourcePermissionEntry[]>([]);
  const [drafts, setDrafts] = React.useState<DraftDirectEntry[]>([]);
  const [addOpen, setAddOpen] = React.useState(false);

  // Load
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getResourcePermissions(resource, uid)
      .then((entries) => {
        if (cancelled) return;
        const { inherited: inh, direct } = splitBuckets(entries);
        setInherited(inh);
        setDrafts(direct.map(entryToDraft).filter((d): d is DraftDirectEntry => d !== null));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load permissions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, uid]);

  const updateLevel = (key: string, level: DraftDirectEntry['level']) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.kind === 'user' && `user:${d.userId}` === key) return { ...d, level };
        if (d.kind === 'team' && `team:${d.teamId}` === key) return { ...d, level };
        if (d.kind === 'role' && `role:${d.role}` === key) return { ...d, level };
        return d;
      }),
    );
  };

  const removeDraft = (key: string) => {
    setDrafts((prev) =>
      prev.filter((d) => {
        if (d.kind === 'user') return `user:${d.userId}` !== key;
        if (d.kind === 'team') return `team:${d.teamId}` !== key;
        return `role:${d.role}` !== key;
      }),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { items } = buildSavePayload(drafts);
      await api.setResourcePermissions(resource, uid, items);
      onSaved?.();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
      data-testid="permissions-dialog"
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Permissions for ${resourceName}`}
        className="relative bg-surface-highest border border-outline-variant rounded-2xl shadow-2xl w-full max-w-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/40">
          <h3 className="text-sm font-bold text-on-surface">
            Permissions — <span className="text-on-surface-variant">{resourceName}</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {loadError ? (
            <div className="px-3 py-2 text-sm bg-error/10 text-error rounded-md">{loadError}</div>
          ) : null}

          {loading ? (
            <div className="text-sm text-on-surface-variant">Loading permissions…</div>
          ) : (
            <>
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant mb-2">
                  Inherited (from parent folders)
                </h4>
                {inherited.length === 0 ? (
                  <div className="text-sm text-on-surface-variant italic px-3 py-2 bg-surface-low rounded-md">
                    No inherited permissions.
                  </div>
                ) : (
                  <div className="bg-surface-low rounded-md border border-outline-variant/40">
                    {inherited.map((e) => {
                      const draft = entryToDraft(e);
                      if (!draft) return null;
                      return (
                        <PermissionRowInherited
                          key={`${e.roleName}:${e.id}`}
                          kind={draft.kind}
                          label={draft.label}
                          level={draft.level}
                          inheritedFrom={e.inheritedFrom?.title}
                        />
                      );
                    })}
                  </div>
                )}
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                    Direct
                  </h4>
                  <button
                    type="button"
                    onClick={() => setAddOpen((v) => !v)}
                    className="px-2.5 py-1 text-xs font-semibold bg-primary/10 text-primary rounded-md hover:bg-primary/20 transition-colors"
                  >
                    + Add permission
                  </button>
                </div>

                {addOpen ? (
                  <div className="mb-3">
                    <AddPermissionFlyout
                      onAdd={(d) => {
                        setDrafts((prev) => upsertDraft(prev, d));
                        setAddOpen(false);
                      }}
                      onClose={() => setAddOpen(false)}
                    />
                  </div>
                ) : null}

                {drafts.length === 0 ? (
                  <div className="text-sm text-on-surface-variant italic px-3 py-2 bg-surface-low rounded-md">
                    No direct permissions yet.
                  </div>
                ) : (
                  <div className="bg-surface-low rounded-md border border-outline-variant/40">
                    {drafts.map((d) => {
                      const key =
                        d.kind === 'user'
                          ? `user:${d.userId}`
                          : d.kind === 'team'
                            ? `team:${d.teamId}`
                            : `role:${d.role}`;
                      return (
                        <PermissionRowEditable
                          key={key}
                          kind={d.kind}
                          label={d.label}
                          level={d.level}
                          onLevelChange={(level) => updateLevel(key, level)}
                          onRemove={() => removeDraft(key)}
                        />
                      );
                    })}
                  </div>
                )}
              </section>

              {saveError ? (
                <div
                  role="alert"
                  className="px-3 py-2 text-sm bg-error/10 text-error rounded-md"
                >
                  {saveError}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-outline-variant/40">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface border border-outline-variant rounded-lg hover:bg-surface-high transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || loading || !!loadError}
            className="px-4 py-2 text-sm font-semibold bg-primary text-on-primary-fixed rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-transform active:scale-95"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return ReactDOM.createPortal(content, document.body);
}

export default PermissionsDialog;
