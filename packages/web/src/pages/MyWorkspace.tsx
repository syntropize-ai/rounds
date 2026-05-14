/**
 * My Workspace — the user's personal scratch area (Wave 1 / PR-C).
 *
 * Backed by `GET /api/workspace/me` which lazy-creates the per-user folder on
 * first access and returns resource counts. Wave 1 ships the Drafts section
 * (dashboards + alert rules currently in the folder). Pinned and Archived
 * stubs are placeholders — they need a `lifecycle_state` field on resources
 * which is a Wave 2 concern. The "Promote" flow (moving items into a shared
 * folder) is Wave 2 too.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import { relativeTime } from '../utils/time.js';

interface Folder {
  id: string;
  uid: string;
  title: string;
  kind: 'personal' | 'shared';
  parentUid: string | null;
}

interface Counts {
  dashboards: number;
  alertRules: number;
  subfolders: number;
}

interface WorkspaceResponse {
  folder: Folder;
  counts: Counts;
}

interface DraftDashboard {
  id: string;
  title: string;
  updatedAt: string;
  folder?: string;
}

interface DraftAlertRule {
  id: string;
  name: string;
  updatedAt?: string;
  folderUid?: string;
}

type Draft =
  | { kind: 'dashboard'; id: string; title: string; updatedAt: string; href: string }
  | { kind: 'alert'; id: string; title: string; updatedAt: string; href: string };

export default function MyWorkspace(): React.ReactElement {
  const navigate = useNavigate();
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const ws = await apiClient.get<WorkspaceResponse>('/workspace/me');
      if (cancelled) return;
      if (ws.error || !ws.data) {
        const msg =
          ws.error && typeof ws.error === 'object' && 'message' in ws.error
            ? (ws.error as { message: string }).message
            : typeof ws.error === 'string'
              ? ws.error
              : 'Failed to load workspace';
        setError(msg);
        setLoading(false);
        return;
      }
      setData(ws.data);
      const folderUid = ws.data.folder.uid;
      // Fetch the two resource kinds in parallel and merge into a unified
      // Drafts feed. Both endpoints accept an unscoped GET — we filter
      // client-side because the workspace folder is small by definition.
      const [dashRes, alertRes] = await Promise.all([
        apiClient.get<DraftDashboard[]>('/dashboards'),
        apiClient.get<DraftAlertRule[]>('/alert-rules'),
      ]);
      if (cancelled) return;
      const merged: Draft[] = [];
      for (const d of dashRes.data ?? []) {
        if (d.folder === folderUid) {
          merged.push({
            kind: 'dashboard',
            id: d.id,
            title: d.title || 'Untitled dashboard',
            updatedAt: d.updatedAt,
            href: `/dashboards/${d.id}`,
          });
        }
      }
      for (const a of alertRes.data ?? []) {
        if (a.folderUid === folderUid) {
          merged.push({
            kind: 'alert',
            id: a.id,
            title: a.name || 'Untitled alert',
            updatedAt: a.updatedAt ?? '',
            href: `/alerts/${a.id}`,
          });
        }
      }
      // Most recently updated first — undated rows sink to the bottom.
      merged.sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || ''));
      setDrafts(merged);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-8 text-sm text-on-surface-variant" data-testid="workspace-loading">
        Loading workspace…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-8 text-sm text-red-600" data-testid="workspace-error">
        {error}
      </div>
    );
  }
  if (!data) return <></>;

  const isEmpty = drafts.length === 0;

  return (
    <div className="p-8 max-w-3xl" data-testid="my-workspace">
      <h1 className="text-2xl font-semibold text-on-surface mb-1">My Workspace</h1>
      <p className="text-sm text-on-surface-variant mb-6">
        Personal scratch area — items here are private to you.
      </p>

      {isEmpty ? (
        <EmptyState />
      ) : (
        <Section title="Drafts" icon="📝" count={drafts.length}>
          <ul className="divide-y divide-outline/30">
            {drafts.map((d) => (
              <li key={`${d.kind}:${d.id}`}>
                <button
                  type="button"
                  onClick={() => navigate(d.href)}
                  className="w-full flex items-center justify-between py-2 px-1 text-left hover:bg-surface-high/40 rounded transition-colors"
                >
                  <span className="text-sm text-on-surface truncate">
                    <span className="text-on-surface-variant mr-2">
                      {d.kind === 'dashboard' ? 'dashboard' : 'alert'}
                    </span>
                    {d.title}
                  </span>
                  <span className="text-xs text-on-surface-variant shrink-0 ml-3">
                    {d.updatedAt ? relativeTime(d.updatedAt) : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* TODO Wave 2 — Pinned and Archived sections require a `lifecycle_state`
          field on dashboards / alert rules. Render placeholder sections so the
          shell matches the product design even though the data isn't wired. */}
      <Section title="Pinned" icon="📌" count={0}>
        <p className="text-xs text-on-surface-variant py-2 px-1">
          Pin items to keep them at the top. (Coming in Wave 2.)
        </p>
      </Section>
      <Section title="Archived" icon="🗄" count={0}>
        <p className="text-xs text-on-surface-variant py-2 px-1">
          Archived items live here. (Coming in Wave 2.)
        </p>
      </Section>
    </div>
  );
}

/** Empty-state block shown when the workspace has no draft items. Exported so
 *  pure renderer tests can assert the copy without rigging the page network. */
export function EmptyState(): React.ReactElement {
  return (
    <div
      className="rounded-lg border border-outline/40 bg-surface-lowest p-6"
      data-testid="workspace-empty"
    >
      <p className="text-sm text-on-surface mb-1">Your workspace is empty.</p>
      <p className="text-sm text-on-surface-variant">
        Ask AI to create a dashboard or alert — temporary explorations land
        here automatically.
      </p>
    </div>
  );
}

function Section({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-on-surface mb-2">
        <span aria-hidden className="mr-2">
          {icon}
        </span>
        {title} <span className="text-on-surface-variant font-normal">({count})</span>
      </h2>
      {children}
    </section>
  );
}
