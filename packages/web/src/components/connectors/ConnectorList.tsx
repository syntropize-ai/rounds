import React from 'react';
import type { ConnectorRow } from './types.js';

export interface ConnectorListProps {
  connectors: readonly ConnectorRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddClick: () => void;
  loading?: boolean;
  canWrite: boolean;
  /** When true, render the "+ New connector" pseudo-row as selected so the
   *  right pane shows the create form. */
  creating?: boolean;
}

function ConnectorIcon({ type }: { type: string }): React.ReactElement {
  const letter = (type[0] ?? '?').toUpperCase();
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--color-surface-high)] text-[10px] font-semibold uppercase text-[var(--color-on-surface-variant)]">
      {letter}
    </span>
  );
}

function isConnected(c: ConnectorRow): boolean {
  if (c.status === 'active') return true;
  if (c.lastVerifiedAt) return true;
  return false;
}

function Row({
  connector,
  selected,
  onSelect,
}: {
  connector: ConnectorRow;
  selected: boolean;
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onSelect(connector.id)}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        selected
          ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
          : 'text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)]/60'
      }`}
    >
      <ConnectorIcon type={connector.type} />
      <span className="min-w-0 flex-1 truncate">{connector.name}</span>
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)]">
        {connector.type}
      </span>
    </button>
  );
}

export function ConnectorList({
  connectors,
  selectedId,
  onSelect,
  onAddClick,
  loading = false,
  canWrite,
  creating = false,
}: ConnectorListProps): React.ReactElement {
  const connected = connectors.filter(isConnected);
  const notConnected = connectors.filter((c) => !isConnected(c));

  return (
    <div className="flex h-full flex-col">
      {/* Sticky header with the primary action — placed at the top so users
          adding a 2nd Kubernetes cluster / Prometheus / Loki / etc. find it
          without scrolling. */}
      <div className="border-b border-[var(--color-outline-variant)]/30 p-2">
        <button
          type="button"
          disabled={!canWrite}
          aria-pressed={creating}
          onClick={onAddClick}
          className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            creating
              ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
              : 'bg-[var(--color-surface-high)] text-[var(--color-on-surface)] hover:bg-[var(--color-surface-highest)]'
          }`}
        >
          <span aria-hidden="true" className="text-base leading-none">+</span>
          <span>New connector</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {loading && (
          <p className="px-2 text-xs text-[var(--color-on-surface-variant)]">Loading connectors…</p>
        )}

        {!loading && connectors.length === 0 && (
          <p className="px-2 text-xs text-[var(--color-on-surface-variant)]">
            No connectors yet. Click “+ New connector” above to add one.
          </p>
        )}

        {connected.length > 0 && (
          <div className="space-y-1">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
              Connected
            </p>
            {connected.map((c) => (
              <Row key={c.id} connector={c} selected={c.id === selectedId} onSelect={onSelect} />
            ))}
          </div>
        )}

        {notConnected.length > 0 && (
          <div className="space-y-1">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
              Not connected
            </p>
            {notConnected.map((c) => (
              <Row key={c.id} connector={c} selected={c.id === selectedId} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ConnectorList;
