import React from 'react';
import type { PermissionLevel } from '@agentic-obs/common';
import { levelLabel, principalIcon, type DraftDirectEntry } from './helpers.js';

interface InheritedRowProps {
  kind: DraftDirectEntry['kind'];
  label: string;
  level: PermissionLevel;
  inheritedFrom?: string;
}

interface EditableRowProps {
  kind: DraftDirectEntry['kind'];
  label: string;
  level: PermissionLevel;
  onLevelChange: (level: PermissionLevel) => void;
  onRemove: () => void;
}

function PrincipalBadge({ kind }: { kind: DraftDirectEntry['kind'] }) {
  const color =
    kind === 'user'
      ? 'bg-primary/10 text-primary'
      : kind === 'team'
        ? 'bg-secondary/10 text-secondary'
        : 'bg-tertiary/10 text-tertiary';
  return (
    <span
      className={`inline-flex items-center justify-center px-2 py-0.5 rounded-md text-xs font-medium ${color}`}
    >
      {principalIcon(kind)}
    </span>
  );
}

export function PermissionRowInherited(props: InheritedRowProps): React.ReactElement {
  const { kind, label, level, inheritedFrom } = props;
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 border-b border-outline-variant/20 last:border-b-0"
      data-testid="permission-row-inherited"
    >
      <PrincipalBadge kind={kind} />
      <span className="flex-1 text-sm text-on-surface truncate">{label}</span>
      <span className="text-xs text-on-surface-variant">{levelLabel(level)}</span>
      {inheritedFrom ? (
        <span className="text-xs text-on-surface-variant italic">(from {inheritedFrom})</span>
      ) : null}
    </div>
  );
}

export function PermissionRowEditable(props: EditableRowProps): React.ReactElement {
  const { kind, label, level, onLevelChange, onRemove } = props;
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 border-b border-outline-variant/20 last:border-b-0"
      data-testid="permission-row-direct"
    >
      <PrincipalBadge kind={kind} />
      <span className="flex-1 text-sm text-on-surface truncate">{label}</span>
      <select
        aria-label={`Permission level for ${label}`}
        value={level}
        onChange={(e) => onLevelChange(Number(e.target.value) as PermissionLevel)}
        className="bg-surface-high text-on-surface text-xs rounded-md px-2 py-1 border border-outline focus:ring-1 focus:ring-primary outline-none"
      >
        <option value={1}>View</option>
        <option value={2}>Edit</option>
        <option value={4}>Admin</option>
      </select>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="p-1 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
