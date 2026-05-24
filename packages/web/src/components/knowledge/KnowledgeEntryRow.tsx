/**
 * Single collapsible knowledge (skill) row. Handles expand + inline edit.
 * Bundled rows render a read-only label in place of edit/delete buttons.
 * The body is rendered as preformatted text — no markdown library is
 * installed in this project, so we keep it readable with whitespace-pre-wrap.
 */
import React, { useState } from 'react';
import type { KnowledgeEntry } from '@agentic-obs/common';
import { btnSecondary } from '../connectors/styles.js';
import KnowledgeEntryForm from './KnowledgeEntryForm.js';
import type { KnowledgeCreateBody } from './knowledge-api.js';

interface Props {
  entry: KnowledgeEntry;
  canWrite: boolean;
  onUpdate: (id: string, body: KnowledgeCreateBody) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function SourceBadge({ source }: { source: KnowledgeEntry['source'] }) {
  const cls =
    source === 'bundled'
      ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
      : 'bg-[var(--color-surface-high)] text-[var(--color-on-surface-variant)]';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {source}
    </span>
  );
}

export default function KnowledgeEntryRow({
  entry,
  canWrite,
  onUpdate,
  onDelete,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const isBundled = entry.source === 'bundled';
  const editable = canWrite && !isBundled;

  const handleSave = async (body: KnowledgeCreateBody) => {
    setBusy(true);
    try {
      await onUpdate(entry.id, body);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${entry.title}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await onDelete(entry.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-[var(--color-outline-variant)]/40 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? `Collapse ${entry.title}` : `Expand ${entry.title}`}
        aria-expanded={expanded}
        className="w-full flex flex-col gap-1 px-3 py-2.5 text-left hover:bg-[var(--color-surface-high)]/40 transition-colors"
      >
        <div className="flex items-center gap-2 w-full">
          <span aria-hidden="true" className="text-[var(--color-on-surface-variant)] w-3">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="font-medium text-[var(--color-on-surface)] flex-1 truncate">
            {entry.title}
          </span>
          <SourceBadge source={entry.source} />
        </div>
        {entry.description && (
          <div className="pl-5 text-xs text-[var(--color-on-surface-variant)] truncate w-full">
            {entry.description}
          </div>
        )}
        {entry.intentTags.length > 0 && (
          <div className="pl-5 flex flex-wrap gap-1.5">
            {entry.intentTags.map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--color-surface-high)] text-[var(--color-on-surface-variant)]"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </button>

      {expanded && (
        <div className="px-6 pb-4 pt-1 space-y-3 text-sm">
          {editing && editable ? (
            <KnowledgeEntryForm
              initial={entry}
              onSubmit={handleSave}
              onCancel={() => setEditing(false)}
              submitting={busy}
            />
          ) : (
            <>
              <div className="text-sm text-[var(--color-on-surface)]">
                {entry.description}
              </div>

              {entry.body ? (
                <pre className="whitespace-pre-wrap font-mono text-sm p-3 rounded-lg bg-[var(--color-surface-lowest)] border border-[var(--color-outline-variant)] overflow-x-auto break-words">
                  {entry.body}
                </pre>
              ) : (
                <p className="text-xs italic text-[var(--color-on-surface-variant)]">
                  No body content.
                </p>
              )}

              {entry.intentTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {entry.intentTags.map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 rounded-full text-xs bg-[var(--color-surface-high)] text-[var(--color-on-surface-variant)]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-on-surface-variant)]">
                <div>
                  <span className="font-medium">{entry.source}</span>
                  {entry.sourceRef ? <> · {entry.sourceRef}</> : null}
                  {' · '}Used {entry.useCount} · Approved {entry.approvedCount} · Rejected {entry.rejectedCount}
                </div>
                <div className="flex items-center gap-2">
                  {isBundled ? (
                    <span className="text-xs text-[var(--color-on-surface-variant)] italic">
                      Bundled — read-only
                    </span>
                  ) : editable ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditing(true)}
                        className={btnSecondary}
                        disabled={busy}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete()}
                        aria-label={`Delete ${entry.title}`}
                        className="px-3 py-2 rounded-lg border border-error/50 text-error text-sm font-medium hover:bg-error/10 transition-colors disabled:opacity-50"
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
