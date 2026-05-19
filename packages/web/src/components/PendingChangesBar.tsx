/**
 * PendingChangesBar — sticky review surface for agent-proposed dashboard
 * modifications.
 *
 * Renders at the top of the workspace viewport (`position: sticky`) so it
 * stays visible no matter where the user scrolls in the dashboard grid. The
 * previous inline placement could scroll out of sight, which surprised
 * operators who'd lose track that a review was pending.
 *
 * When `changes.length === 0` it renders nothing (no empty bar).
 */

import React, { useState } from 'react';

export interface PendingChangeSummary {
  id: string;
  proposedAt: string;
  proposedBy: string;
  summary: string;
}

/** Pure helpers exported for tests. */
export function allChangeIds(changes: PendingChangeSummary[]): string[] {
  return changes.map((c) => c.id);
}

export function toggleSelection(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export interface PendingChangesBarProps {
  changes: PendingChangeSummary[];
  /** Accept the listed change ids (empty = no-op). */
  onAccept: (ids: string[]) => void;
  /** Reject (discard) the listed change ids. */
  onDiscard: (ids: string[]) => void;
  busy?: boolean;
  /** Top offset for `position: sticky` — should match the workspace's top
   *  bar height so the sticky bar tucks just under it. Defaults to 0. */
  stickyTop?: number;
}

export default function PendingChangesBar({
  changes,
  onAccept,
  onDiscard,
  busy,
  stickyTop = 0,
}: PendingChangesBarProps) {
  const [hidden, setHidden] = useState(false);

  if (changes.length === 0) return null;

  const acceptAll = () => onAccept(changes.map((c) => c.id));
  const discardAll = () => onDiscard(changes.map((c) => c.id));

  // Collapsed chip — small affordance the user can click to re-expand.
  if (hidden) {
    return (
      <div
        data-testid="pending-changes-bar"
        style={{ position: 'sticky', top: stickyTop, zIndex: 20 }}
        className="px-6 pt-2"
      >
        <button
          type="button"
          data-testid="pending-changes-chip"
          onClick={() => setHidden(false)}
          className="inline-flex items-center gap-1.5 rounded-full bg-[#F59E0B]/15 border border-[#F59E0B]/40 px-2.5 py-1 text-xs font-semibold text-[#F59E0B] hover:bg-[#F59E0B]/25"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#F59E0B]" />
          {changes.length} pending {changes.length === 1 ? 'change' : 'changes'}
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="pending-changes-bar"
      data-sticky="true"
      style={{ position: 'sticky', top: stickyTop, zIndex: 20 }}
      className="border-l-4 border-[#F59E0B] bg-[#F59E0B]/5 backdrop-blur-sm px-4 py-2 mx-6 mt-3 rounded-md shadow-sm"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span
          aria-hidden
          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#F59E0B]/15 text-[#F59E0B] text-xs"
          title="Pending changes"
        >
          !
        </span>
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide bg-[#F59E0B]/10 text-[#F59E0B]">
          {changes.length} pending {changes.length === 1 ? 'change' : 'changes'}
        </span>
        <span className="text-sm text-on-surface-variant">
          The assistant proposed modifications. Review before applying.
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="pending-accept-all"
            disabled={busy}
            onClick={acceptAll}
            className="px-2.5 py-1 rounded-md text-xs bg-primary text-on-primary-fixed font-semibold hover:opacity-90 disabled:opacity-50"
          >
            Accept all
          </button>
          <button
            type="button"
            data-testid="pending-discard-all"
            disabled={busy}
            onClick={discardAll}
            className="px-2.5 py-1 rounded-md text-xs border border-outline-variant hover:bg-surface-high disabled:opacity-50"
          >
            Reject all
          </button>
          <button
            type="button"
            data-testid="pending-hide"
            onClick={() => setHidden(true)}
            className="px-2.5 py-1 rounded-md text-xs hover:bg-surface-high text-on-surface-variant"
          >
            Hide
          </button>
        </div>
      </div>
    </div>
  );
}
