import React from 'react';
import type { ConnectorHumanPolicy } from '@agentic-obs/common';

/**
 * Three icon-buttons (Allow / Ask / Block). The currently-selected policy is
 * rendered with a filled background; the others are outline. Clicking any
 * button calls `onChange` with the new policy (no-op when it matches
 * `current` and `inherited` is false — we still PUT so the optimistic UI
 * can mark the row as "explicit").
 */
export interface PolicyIconButtonsProps {
  current: ConnectorHumanPolicy;
  onChange: (next: ConnectorHumanPolicy) => void;
  disabled?: boolean;
  /** When true, no row is highlighted as "explicit" — the resolved value is
   *  inherited from a higher scope or the template default. */
  inherited?: boolean;
  ariaLabelPrefix: string;
}

const OPTIONS: ReadonlyArray<{
  value: ConnectorHumanPolicy;
  glyph: string;
  label: string;
}> = [
  { value: 'allow', glyph: '✓', label: 'Allow' },
  { value: 'ask', glyph: '✋', label: 'Ask' },
  { value: 'block', glyph: '⊘', label: 'Block' },
];

const FILLED: Record<ConnectorHumanPolicy, string> = {
  allow: 'bg-secondary/15 text-secondary border-secondary/40',
  ask: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',
  block: 'bg-error/15 text-error border-error/40',
};

const OUTLINE =
  'bg-transparent text-[var(--color-on-surface-variant)] border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)]/40';

export function PolicyIconButtons({
  current,
  onChange,
  disabled = false,
  inherited = false,
  ariaLabelPrefix,
}: PolicyIconButtonsProps): React.ReactElement {
  return (
    <div role="group" aria-label={`${ariaLabelPrefix} policy`} className="inline-flex gap-1">
      {OPTIONS.map((opt) => {
        const isCurrent = !inherited && opt.value === current;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-label={`${ariaLabelPrefix}: ${opt.label}`}
            aria-pressed={isCurrent}
            title={opt.label}
            onClick={() => onChange(opt.value)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition-colors disabled:opacity-40 ${
              isCurrent ? FILLED[opt.value] : OUTLINE
            }`}
          >
            <span aria-hidden="true">{opt.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

export default PolicyIconButtons;
