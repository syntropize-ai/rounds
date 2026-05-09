/**
 * PendingChangesBar — review surface for AI-proposed dashboard modifications.
 *
 * Shown above the dashboard grid when the dashboard has pending changes
 * (queued by the agent because the dashboard pre-existed this chat session).
 * The user can:
 *   - Review (expand to see each change's summary)
 *   - Accept all / Accept selected
 *   - Reject (discard) selected / all
 *
 * Sister surface to RiskAwareConfirm — same "preview before apply" intent,
 * different audience: that one gates risky writes inside the chat strip;
 * this one gates AI edits to a shared dashboard. Dashboard edits don't
 * invoke ActionGuard (low-risk, user_conversation source per Task 05's
 * matrix), so the bar handles accept/discard locally.
 */

import React, { useState } from 'react';

export interface PendingChangeSummary {
  id: string;
  proposedAt: string;
  proposedBy: string;
  summary: string;
}

/** Pure helpers exported for tests (web vitest runs without jsdom, so we
 *  can't drive the component's hooks from a test renderer). */
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
  /** Apply the listed change ids. Empty list is a no-op. */
  onAccept: (ids: string[]) => void;
  /** Discard the listed change ids without mutating the dashboard. */
  onDiscard: (ids: string[]) => void;
  busy?: boolean;
}

export default function PendingChangesBar({
  changes,
  onAccept,
  onDiscard,
  busy,
}: PendingChangesBarProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  if (changes.length === 0) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const acceptAll = () => onAccept(changes.map((c) => c.id));
  const acceptSelected = () => onAccept(Array.from(selected));
  const discardAll = () => onDiscard(changes.map((c) => c.id));
  const discardSelected = () => onDiscard(Array.from(selected));

  return (
    <div
      data-testid="pending-changes-bar"
      className="border-l-4 border-[#F59E0B] bg-[#F59E0B]/5 px-4 py-2 mx-6 mt-3 rounded-md"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide bg-[#F59E0B]/10 text-[#F59E0B]">
          {changes.length} pending {changes.length === 1 ? 'change' : 'changes'}
        </span>
        <span className="text-sm text-on-surface-variant">
          The assistant proposed modifications. Review before applying.
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="pending-toggle-review"
            onClick={() => setExpanded((v) => !v)}
            className="px-2.5 py-1 rounded-md text-xs hover:bg-surface-high text-on-surface-variant"
          >
            {expanded ? 'Collapse' : 'Review'}
          </button>
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
            Discard all
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-1.5">
          {changes.map((c) => (
            <label
              key={c.id}
              data-testid={`pending-row-${c.id}`}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <input
                type="checkbox"
                data-testid={`pending-select-${c.id}`}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="text-on-surface">{c.summary}</span>
              <span className="text-xs text-on-surface-variant ml-auto">
                {c.proposedBy}
              </span>
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              data-testid="pending-accept-selected"
              disabled={busy || selected.size === 0}
              onClick={acceptSelected}
              className="px-2.5 py-1 rounded-md text-xs bg-primary text-on-primary-fixed font-semibold hover:opacity-90 disabled:opacity-50"
            >
              Accept selected ({selected.size})
            </button>
            <button
              type="button"
              data-testid="pending-discard-selected"
              disabled={busy || selected.size === 0}
              onClick={discardSelected}
              className="px-2.5 py-1 rounded-md text-xs border border-outline-variant hover:bg-surface-high disabled:opacity-50"
            >
              Discard selected
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
