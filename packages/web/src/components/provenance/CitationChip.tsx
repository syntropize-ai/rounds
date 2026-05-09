import React from 'react';
import type { Citation, CitationKind } from '@agentic-obs/common';

interface Props {
  ref_: string;
  kind: CitationKind;
  /** When the report has a citations list, the chip can show the summary in a
   *  hover card. We accept the matched citation directly so the parent doesn't
   *  pay for a lookup on every render. */
  citation?: Citation;
  /** Click-handler — typically scrolls/highlights the matching evidence item
   *  in the EvidenceDrawer. Optional so the chip degrades to a passive label
   *  if the parent didn't wire a drawer. */
  onClick?: (ref: string) => void;
}

const KIND_STYLE: Record<CitationKind, string> = {
  metric: 'bg-primary/15 text-primary',
  log: 'bg-secondary/15 text-secondary',
  k8s: 'bg-tertiary/15 text-tertiary',
  change: 'bg-error/15 text-error',
};

/**
 * Inline superscript chip rendered for `[m1]`, `[l1]`, `[k1]`, `[c1]` tokens
 * in AI markdown. Hover reveals the citation summary; click scrolls the
 * matching item into view in the <EvidenceDrawer />.
 */
export default function CitationChip({ ref_, kind, citation, onClick }: Props) {
  const handleClick = onClick
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        onClick(ref_);
      }
    : undefined;
  return (
    <sup className="inline-block align-super mx-0.5">
      <button
        type="button"
        data-testid={`citation-chip-${ref_}`}
        data-citation-ref={ref_}
        title={citation?.summary ?? `${kind} ${ref_}`}
        onClick={handleClick}
        className={
          'cursor-pointer rounded px-1 py-0.5 text-[10px] font-mono leading-none ' +
          'hover:ring-1 hover:ring-current/40 ' +
          KIND_STYLE[kind]
        }
      >
        {ref_}
      </button>
    </sup>
  );
}
