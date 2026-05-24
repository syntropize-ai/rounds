/**
 * Add/edit form for a knowledge entry. Used both for "+ New entry" at the top
 * of the list and inline editing inside an expanded row. Pure helpers
 * (parseTags, parseJsonContent, formatContentForEdit) are exported so the
 * node-only test env can verify them without a DOM.
 */
import React, { useMemo, useState } from 'react';
import type { KnowledgeEntry, KnowledgeKind } from '@agentic-obs/common';
import { btnPrimary, btnSecondary, inputCls, selectCls } from '../connectors/styles.js';
import type { KnowledgeWriteBody } from './knowledge-api.js';

const KINDS: KnowledgeKind[] = ['pattern', 'template', 'metric_doc', 'system_fact'];

/**
 * Split a comma-separated tag string into a trimmed, deduped, non-empty list.
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Try to parse the content textarea as JSON. Returns the parsed value on
 * success or an error message string on failure. Empty input is treated as
 * `{}` so the user can omit content for a stub entry.
 */
export function parseJsonContent(
  raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Invalid JSON',
    };
  }
}

/**
 * Pretty-print an arbitrary content value back into the editor textarea.
 */
export function formatContentForEdit(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

interface Props {
  initial?: KnowledgeEntry;
  onSubmit: (body: KnowledgeWriteBody) => Promise<void> | void;
  onCancel: () => void;
  submitting?: boolean;
}

export default function KnowledgeEntryForm({ initial, onSubmit, onCancel, submitting }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [kind, setKind] = useState<KnowledgeKind>(initial?.kind ?? 'pattern');
  const [tags, setTags] = useState((initial?.intentTags ?? []).join(', '));
  const [sourceRef, setSourceRef] = useState(initial?.sourceRef ?? '');
  const [content, setContent] = useState(() => formatContentForEdit(initial?.content));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const isEdit = !!initial;
  const canSubmit = useMemo(() => title.trim().length > 0 && !submitting, [title, submitting]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const parsed = parseJsonContent(content);
    if (!parsed.ok) {
      setJsonError(parsed.message);
      return;
    }
    setJsonError(null);
    const body: KnowledgeWriteBody = {
      title: title.trim(),
      kind,
      intentTags: parseTags(tags),
      content: parsed.value,
      sourceRef: sourceRef.trim() ? sourceRef.trim() : null,
    };
    void onSubmit(body);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)]">
      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputCls}
          placeholder="e.g. Database connection saturation pattern"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">Kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)} className={selectCls}>
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">Source ref (optional)</label>
          <input
            type="text"
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            className={inputCls}
            placeholder="https://… or doc id"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">Intent tags</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className={inputCls}
          placeholder="comma, separated, tags"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">Content (JSON)</label>
        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); if (jsonError) setJsonError(null); }}
          className={inputCls + ' font-mono'}
          style={{ minHeight: 200 }}
          placeholder='{ "applicableWhen": "...", "structure": { "rowGroups": [] } }'
        />
        {jsonError && (
          <p className="text-xs text-error mt-1" role="alert">JSON error: {jsonError}</p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={btnSecondary} disabled={submitting}>Cancel</button>
        <button type="submit" className={btnPrimary} disabled={!canSubmit}>
          {submitting ? 'Saving…' : isEdit ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  );
}
