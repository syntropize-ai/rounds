/**
 * FolderPicker — minimal &lt;select&gt; that lists folders accessible to the
 * current user, optionally filtered to `kind === 'shared'`.
 *
 * Built on `/api/folders` (already RBAC-gated). The promote flow needs to
 * exclude personal workspaces so the destination is always a team folder
 * — `?kind=shared` is the canonical filter; we also defensively drop any
 * `personal` rows the server might return (back-compat with folder rows
 * predating the field, which default to `'shared'`).
 *
 * This is a small primitive on purpose. Tree drill-down / search can wait
 * for a follow-up — the promote dialog only needs to pick ONE uid.
 */

import { useEffect, useState } from 'react';

interface FolderRow {
  uid: string;
  title: string;
  kind?: 'personal' | 'shared';
}

export interface FolderPickerProps {
  kind?: 'personal' | 'shared';
  value: string;
  onChange: (uid: string) => void;
}

export default function FolderPicker({
  kind,
  value,
  onChange,
}: FolderPickerProps): React.ReactElement {
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = kind ? `/api/folders?kind=${kind}` : '/api/folders';
    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error?.message ?? `request failed: ${res.status}`);
        }
        return res.json() as Promise<{ items?: FolderRow[] } | FolderRow[]>;
      })
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : (data.items ?? []);
        const filtered = kind
          ? rows.filter((f) => (f.kind ?? 'shared') === kind)
          : rows;
        setFolders(filtered);
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
  }, [kind]);

  if (error) {
    return <div className="text-sm text-[var(--color-error)]">{error}</div>;
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={loading}
      className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)]"
    >
      <option value="">
        {loading ? 'Loading folders…' : 'Pick a folder'}
      </option>
      {folders.map((f) => (
        <option key={f.uid} value={f.uid}>
          {f.title}
        </option>
      ))}
    </select>
  );
}
