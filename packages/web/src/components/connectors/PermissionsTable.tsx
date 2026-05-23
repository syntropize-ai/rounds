import React from 'react';
import type {
  ConnectorHumanPolicy,
  ConnectorPolicy,
  ConnectorSubjectType,
} from '@agentic-obs/common';
import { capabilityKind } from './capability-kind.js';
import PolicyIconButtons from './PolicyIconButtons.js';

export type ResolutionSource = 'explicit' | 'inherited-org' | 'default';

export interface ResolvedRow {
  capability: string;
  policy: ConnectorHumanPolicy;
  source: ResolutionSource;
}

export interface PermissionsTableProps {
  capabilities: readonly string[];
  /** Policy rows for the currently-selected scope (org or team). */
  scopeRows: readonly ConnectorPolicy[];
  /** Policy rows for the org scope. Only consulted when scope is `team` so
   *  inherited values can be displayed. Empty array when scope is org. */
  orgRows: readonly ConnectorPolicy[];
  scope: ConnectorSubjectType;
  disabled?: boolean;
  onSet: (capability: string, next: ConnectorHumanPolicy) => void;
  /** Reset a team-level override → DELETE row, fall back to inherited. */
  onReset?: (capability: string) => void;
}

/** Default when no policy row exists at any level. */
const FALLBACK_POLICY: ConnectorHumanPolicy = 'ask';

export function resolveRows(
  capabilities: readonly string[],
  scopeRows: readonly ConnectorPolicy[],
  orgRows: readonly ConnectorPolicy[],
  scope: ConnectorSubjectType,
): ResolvedRow[] {
  const scopeByCap = new Map(scopeRows.map((r) => [r.capability, r]));
  const orgByCap = new Map(orgRows.map((r) => [r.capability, r]));
  return capabilities.map((cap) => {
    const scoped = scopeByCap.get(cap);
    if (scoped) {
      return { capability: cap, policy: scoped.humanPolicy, source: 'explicit' };
    }
    if (scope === 'team') {
      const org = orgByCap.get(cap);
      if (org) {
        return { capability: cap, policy: org.humanPolicy, source: 'inherited-org' };
      }
    }
    return { capability: cap, policy: FALLBACK_POLICY, source: 'default' };
  });
}

function Group({
  title,
  rows,
  scope,
  disabled,
  onSet,
  onReset,
}: {
  title: string;
  rows: readonly ResolvedRow[];
  scope: ConnectorSubjectType;
  disabled: boolean;
  onSet: (cap: string, next: ConnectorHumanPolicy) => void;
  onReset?: (cap: string) => void;
}): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
        {title}
      </p>
      <ul className="divide-y divide-[var(--color-outline-variant)]/40 rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)]">
        {rows.map((row) => {
          const hint =
            row.source === 'inherited-org'
              ? 'inherited'
              : row.source === 'default'
                ? 'default'
                : null;
          return (
            <li
              key={row.capability}
              className="flex items-center justify-between gap-3 px-3 py-2"
              data-testid={`capability-row-${row.capability}`}
            >
              <div className="min-w-0">
                <code className="text-xs text-[var(--color-on-surface)]">{row.capability}</code>
                {hint && (
                  <span
                    className="ml-2 rounded bg-[var(--color-surface-high)]/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)]"
                    data-testid={`capability-hint-${row.capability}`}
                  >
                    {hint}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {scope === 'team' && row.source === 'explicit' && onReset && (
                  <button
                    type="button"
                    disabled={disabled}
                    className="text-[11px] text-[var(--color-on-surface-variant)] underline hover:text-[var(--color-on-surface)] disabled:opacity-40"
                    onClick={() => onReset(row.capability)}
                    aria-label={`Reset ${row.capability} to inherited`}
                  >
                    Reset
                  </button>
                )}
                <PolicyIconButtons
                  current={row.policy}
                  inherited={row.source !== 'explicit'}
                  disabled={disabled}
                  onChange={(next) => onSet(row.capability, next)}
                  ariaLabelPrefix={row.capability}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PermissionsTable({
  capabilities,
  scopeRows,
  orgRows,
  scope,
  disabled = false,
  onSet,
  onReset,
}: PermissionsTableProps): React.ReactElement {
  const resolved = resolveRows(capabilities, scopeRows, orgRows, scope);
  const reads = resolved.filter((r) => capabilityKind(r.capability) === 'read');
  const writes = resolved.filter((r) => capabilityKind(r.capability) === 'write');

  if (capabilities.length === 0) {
    return (
      <p className="text-sm text-[var(--color-on-surface-variant)]">
        This connector exposes no declared capabilities.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Group
        title="Read"
        rows={reads}
        scope={scope}
        disabled={disabled}
        onSet={onSet}
        {...(onReset ? { onReset } : {})}
      />
      <Group
        title="Write"
        rows={writes}
        scope={scope}
        disabled={disabled}
        onSet={onSet}
        {...(onReset ? { onReset } : {})}
      />
    </div>
  );
}

export default PermissionsTable;
