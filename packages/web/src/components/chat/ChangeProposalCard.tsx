import React, { useState, useCallback } from 'react';
import { pendingChangesApi } from '../../api/client.js';
import type {
  PendingChangeKind,
  PendingChangeStatus,
} from '../../types/pending-changes.js';

/**
 * Inline change-proposal card rendered in the chat conversation. Replaces the
 * old per-panel ring / sticky bar / nav bell with a Claude-Code-style inline
 * affordance: AI says "I'll change X", a card appears right below the
 * tool_call, user clicks Apply or Cancel, conversation continues.
 *
 * Status transitions:
 *   pending  → ✓ Apply / ✗ Cancel buttons visible
 *   accepted → header turns to "Applied", buttons hidden
 *   rejected → header turns to "Cancelled", muted
 *   expired  → header turns to "Expired", subtitle explains TTL
 */
export interface ChangeProposalProps {
  proposalId: string;
  dashboardId: string;
  panelId?: string | null;
  changeKind: PendingChangeKind;
  summary: string;
  beforeJson: unknown;
  afterJson: unknown;
  /** Starting status. The card mutates this locally on Apply/Cancel; the
   *  parent may also push a fresh value via `controlledStatus` after a
   *  refresh-time overlay query. */
  initialStatus: PendingChangeStatus;
  /** When provided, overrides the local state — used by chat-history replay
   *  to show the authoritative current status after refresh / cross-tab. */
  controlledStatus?: PendingChangeStatus;
  /** Resolution timestamp shown next to "已应用" / "已取消". */
  resolvedAt?: string | null;
}

/**
 * Compute 2-5 tiny diff bullets from before/after JSON for the given
 * changeKind. Designed for chat readability — we deliberately omit
 * unchanged fields and truncate long values.
 *
 * Algorithm (per changeKind):
 *   - modify_panel: walk the small whitelist of load-bearing panel fields
 *     (`visualization`, `queries[0].expr`, `queries[0].legendFormat`, `title`,
 *     `unit`, `description`); for each one where before !== after, emit
 *     `• <label>: <before> → <after>`. Skips fields equal/absent in both
 *     so an unchanged title doesn't add noise.
 *   - add_panel: read the proposed panel and surface `title`, `visualization`,
 *     and first query expression (truncated to 60 chars).
 *   - remove_panel: single bullet with the panel title.
 *   - set_title: `• 标题: "<before>" → "<after>"` only (description in a
 *     second bullet if it changed).
 *   - add_variable: `• 新增变量: <key> (default: <defaultValue>)`.
 *
 * Returns at most 5 bullets — beyond that the card feels too busy.
 */
export function derivedDiffBullets(
  changeKind: PendingChangeKind,
  beforeJson: unknown,
  afterJson: unknown,
): string[] {
  const trunc = (s: string, n = 60): string =>
    s.length > n ? `${s.slice(0, n)}…` : s;
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'string') return `"${trunc(v)}"`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return trunc(JSON.stringify(v));
  };

  const bullets: string[] = [];

  if (changeKind === 'modify_panel') {
    const before = (beforeJson as Record<string, unknown> | null) ?? {};
    const after = (afterJson as Record<string, unknown> | null) ?? {};
    const fields: Array<{ label: string; pick: (o: Record<string, unknown>) => unknown }> = [
      { label: 'visualization', pick: (o) => o['visualization'] },
      { label: 'title', pick: (o) => o['title'] },
      { label: 'unit', pick: (o) => o['unit'] },
      { label: 'description', pick: (o) => o['description'] },
      {
        label: 'query',
        pick: (o) => {
          const qs = o['queries'] as Array<{ expr?: string }> | undefined;
          return qs?.[0]?.expr;
        },
      },
      {
        label: 'legendFormat',
        pick: (o) => {
          const qs = o['queries'] as Array<{ legendFormat?: string }> | undefined;
          return qs?.[0]?.legendFormat;
        },
      },
    ];
    for (const f of fields) {
      const b = f.pick(before);
      const a = f.pick(after);
      if (JSON.stringify(b) === JSON.stringify(a)) continue;
      bullets.push(`${f.label}: ${fmt(b)} → ${fmt(a)}`);
      if (bullets.length >= 5) break;
    }
  } else if (changeKind === 'add_panel') {
    const after = (afterJson as Record<string, unknown> | null) ?? {};
    const title = typeof after['title'] === 'string' ? (after['title'] as string) : '(untitled)';
    const viz = typeof after['visualization'] === 'string' ? (after['visualization'] as string) : '?';
    bullets.push(`Panel: ${title}`);
    bullets.push(`Visualization: ${viz}`);
    const qs = after['queries'] as Array<{ expr?: string }> | undefined;
    const expr = qs?.[0]?.expr;
    if (expr) bullets.push(`Query: ${trunc(expr, 60)}`);
  } else if (changeKind === 'remove_panel') {
    const before = (beforeJson as Record<string, unknown> | null) ?? {};
    const title = typeof before['title'] === 'string' ? (before['title'] as string) : '(untitled)';
    bullets.push(`Removed panel: ${title}`);
  } else if (changeKind === 'set_title') {
    const before = (beforeJson as Record<string, unknown> | null) ?? {};
    const after = (afterJson as Record<string, unknown> | null) ?? {};
    if (before['title'] !== after['title']) {
      bullets.push(`Title: ${fmt(before['title'])} → ${fmt(after['title'])}`);
    }
    if ((before['description'] ?? '') !== (after['description'] ?? '')) {
      bullets.push(`Description: ${fmt(before['description'])} → ${fmt(after['description'])}`);
    }
  } else if (changeKind === 'add_variable') {
    const v = (afterJson as Record<string, unknown> | null) ?? {};
    const name =
      typeof v['name'] === 'string'
        ? (v['name'] as string)
        : typeof v['key'] === 'string'
          ? (v['key'] as string)
          : '?';
    const def = v['defaultValue'] ?? v['current'] ?? '';
    bullets.push(`Variable: ${name}${def ? ` (default: ${String(def)})` : ''}`);
  }

  return bullets;
}

const STATUS_PRESENTATION: Record<
  PendingChangeStatus,
  { header: string; borderClass: string; opacityClass: string }
> = {
  pending: {
    header: 'Pending your approval',
    borderClass: 'border-amber-400/50',
    opacityClass: '',
  },
  accepted: {
    header: 'Applied',
    borderClass: 'border-emerald-500/50',
    opacityClass: '',
  },
  rejected: {
    header: 'Cancelled',
    borderClass: 'border-outline-variant',
    opacityClass: 'opacity-60',
  },
  expired: {
    header: 'Expired',
    borderClass: 'border-outline-variant',
    opacityClass: 'opacity-50',
  },
};

function formatTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChangeProposalCard(props: ChangeProposalProps) {
  const {
    proposalId,
    dashboardId,
    changeKind,
    summary,
    beforeJson,
    afterJson,
    initialStatus,
    controlledStatus,
    resolvedAt: initialResolvedAt = null,
  } = props;

  const [localStatus, setLocalStatus] = useState<PendingChangeStatus>(initialStatus);
  const [resolvedAt, setResolvedAt] = useState<string | null>(initialResolvedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the user has clicked Apply / Cancel locally, the local resolution
  // outranks any stale controlledStatus from a prior fetch — otherwise the
  // overlay flips the card back to 'pending' until the next refresh.
  const [locallyResolved, setLocallyResolved] = useState(false);

  const status: PendingChangeStatus = locallyResolved
    ? localStatus
    : (controlledStatus ?? localStatus);
  const presentation = STATUS_PRESENTATION[status];
  const bullets = derivedDiffBullets(changeKind, beforeJson, afterJson);

  const onApply = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await pendingChangesApi.accept(dashboardId, proposalId);
      setLocalStatus('accepted');
      setResolvedAt(new Date().toISOString());
      setLocallyResolved(true);
      window.dispatchEvent(
        new CustomEvent('dashboard:refresh-panels', { detail: { dashboardId } }),
      );
      // Notify the Layout-level overlay so groupEvents picks up the new
      // status and reveals the hidden tail of the conversation.
      window.dispatchEvent(new CustomEvent('dashboard:pending-changes-updated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBusy(false);
    }
  }, [busy, dashboardId, proposalId]);

  const onCancel = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await pendingChangesApi.reject(dashboardId, proposalId);
      setLocalStatus('rejected');
      setResolvedAt(new Date().toISOString());
      setLocallyResolved(true);
      window.dispatchEvent(new CustomEvent('dashboard:pending-changes-updated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }, [busy, dashboardId, proposalId]);

  return (
    <div
      data-testid={`change-proposal-${proposalId}`}
      data-status={status}
      className={`my-3 rounded-lg border ${presentation.borderClass} ${presentation.opacityClass} bg-surface-container px-3 py-2 text-sm`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-semibold text-on-surface">
          {status === 'pending' ? '🟡' : status === 'accepted' ? '✓' : status === 'rejected' ? '✗' : '⏱'}
          {' '}
          {presentation.header}
        </span>
        {status === 'accepted' && resolvedAt && (
          <span className="text-[10px] text-on-surface-variant">
            {formatTime(resolvedAt)}
          </span>
        )}
        {status === 'expired' && (
          <span className="text-[10px] text-on-surface-variant">7天未审批,自动清理</span>
        )}
      </div>

      <div className="text-xs text-on-surface mb-1.5">{summary}</div>

      {bullets.length > 0 && (
        <ul className="text-[11px] text-on-surface-variant space-y-0.5 mb-2 list-none">
          {bullets.map((b, i) => (
            <li key={i}>• {b}</li>
          ))}
        </ul>
      )}

      {error && (
        <div className="text-[11px] text-error mb-1.5" role="alert">
          {error}
        </div>
      )}

      {status === 'pending' && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid={`change-proposal-apply-${proposalId}`}
            onClick={() => void onApply()}
            disabled={busy}
            className="px-2.5 py-1 rounded text-xs font-semibold bg-amber-400 text-amber-950 hover:bg-amber-300 disabled:opacity-50 transition-colors"
          >
            ✓ Apply
          </button>
          <button
            type="button"
            data-testid={`change-proposal-cancel-${proposalId}`}
            onClick={() => void onCancel()}
            disabled={busy}
            className="px-2.5 py-1 rounded text-xs border border-outline-variant text-on-surface-variant hover:bg-surface-high disabled:opacity-50 transition-colors"
          >
            ✗ Cancel
          </button>
        </div>
      )}
    </div>
  );
}
