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
      {/* The middle column is a vertical list — no header bar. The "add"
          affordance is a compact "+" pseudo-row appended after the last
          connector (and rendered as selected when `creating`), matching
          the row geometry so the eye reads it as "next slot". */}
      {/* Top padding (`pt-12`) matches the height of the Settings left rail
          header bar so the middle column's first label ("CONNECTED") sits
          on the same horizontal baseline as the left rail's first nav item
          ("Connectors"). Without it, the small-caps label clings to the
          top edge while the left rail's bold "Settings" h1 dominates,
          making the column feel top-heavy. */}
      <div className="flex-1 overflow-y-auto px-2 pt-12 pb-3 space-y-4">
        {loading && (
          <p className="px-2 text-xs text-[var(--color-on-surface-variant)]">Loading connectors…</p>
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

        {/* Add affordance — sits below the last connector, same row geometry
            so it looks like the "next slot". Uses a dashed border + muted
            color to read as additive rather than as a real connector. */}
        <div className={connected.length === 0 && notConnected.length === 0 ? '' : 'pt-1'}>
          <button
            type="button"
            disabled={!canWrite}
            aria-pressed={creating}
            aria-label="Add connector"
            onClick={onAddClick}
            className={`flex w-full items-center gap-2 rounded-md border border-dashed px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
              creating
                ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                : 'border-[var(--color-outline-variant)]/60 text-[var(--color-on-surface-variant)] hover:border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)]/40 hover:text-[var(--color-on-surface)]'
            }`}
          >
            <span
              aria-hidden="true"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-base leading-none"
            >
              +
            </span>
            <span className="min-w-0 flex-1 truncate">
              {connectors.length === 0 ? 'Add your first connector' : 'Add connector'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConnectorList;
