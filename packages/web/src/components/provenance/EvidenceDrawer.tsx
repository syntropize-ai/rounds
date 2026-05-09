import React, { useEffect, useRef } from 'react';
import type { Citation, CitationKind } from '@agentic-obs/common';

interface Props {
  citations: Citation[];
  /** Citation `ref` (e.g. `m1`) that should be visually highlighted; used by
   *  the parent to sync the drawer with a clicked CitationChip. */
  highlightedRef?: string | null;
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL: Record<CitationKind, string> = {
  metric: 'Metric',
  log: 'Log',
  k8s: 'K8s',
  change: 'Change',
};

const KIND_DOT: Record<CitationKind, string> = {
  metric: 'bg-primary',
  log: 'bg-secondary',
  k8s: 'bg-tertiary',
  change: 'bg-error',
};

/**
 * Side panel listing every evidence citation in a report (Task 10). The
 * parent owns open/close state and tracks which citation is highlighted —
 * the drawer scrolls that row into view when it changes. Reusing
 * `<RiskAwareConfirm />`-style overlays would be overkill here; a minimal
 * drawer keeps the surface area small.
 */
export default function EvidenceDrawer({
  citations,
  highlightedRef,
  open,
  onClose,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !highlightedRef || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-citation-ref="${highlightedRef}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [open, highlightedRef]);

  if (!open) return null;

  return (
    <div
      data-testid="evidence-drawer"
      className="fixed top-0 right-0 h-full w-80 bg-surface shadow-xl border-l border-outline z-40 flex flex-col"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline">
        <h4 className="text-sm font-semibold text-on-surface">Evidence</h4>
        <button
          type="button"
          onClick={onClose}
          className="text-on-surface-variant hover:text-on-surface text-sm"
        >
          Close
        </button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {citations.length === 0 ? (
          <p className="text-xs text-on-surface-variant">
            No citations were attached to this report.
          </p>
        ) : (
          citations.map((c) => (
            <div
              key={c.ref}
              data-citation-ref={c.ref}
              className={
                'rounded-lg p-2.5 text-xs ' +
                (highlightedRef === c.ref
                  ? 'bg-primary/10 ring-1 ring-primary/40'
                  : 'bg-surface-high')
              }
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2 h-2 rounded-full ${KIND_DOT[c.kind]}`} />
                <span className="font-mono text-on-surface">{c.ref}</span>
                <span className="text-on-surface-variant/70 uppercase tracking-wider text-[10px]">
                  {KIND_LABEL[c.kind]}
                </span>
              </div>
              <p className="text-on-surface-variant leading-snug">{c.summary}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
