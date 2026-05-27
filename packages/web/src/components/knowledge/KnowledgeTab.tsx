/**
 * Top-level Knowledge settings tab: header + source filter + skill list.
 * Skill-style: every entry is a markdown skill the agent consults based on
 * its description. Bundled entries are read-only; saved/distilled are
 * editable when canWrite is true.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { KnowledgeEntry, KnowledgeSource } from '@agentic-obs/common';
import { selectCls } from '../connectors/styles.js';
import KnowledgeEntryForm from './KnowledgeEntryForm.js';
import KnowledgeEntryRow from './KnowledgeEntryRow.js';
import {
  defaultKnowledgeApi,
  type KnowledgeApi,
  type KnowledgeCreateBody,
} from './knowledge-api.js';

interface Props {
  canWrite: boolean;
  /** Injection point for tests + Storybook. Defaults to the real REST client. */
  api?: KnowledgeApi;
}

type SourceFilter = 'all' | KnowledgeSource;

const SOURCE_OPTIONS: SourceFilter[] = ['all', 'bundled', 'saved', 'distilled'];

export default function KnowledgeTab({ canWrite, api = defaultKnowledgeApi }: Props) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [showNewForm, setShowNewForm] = useState(false);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.list({
        source: sourceFilter === 'all' ? undefined : sourceFilter,
      });
      setEntries(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge entries');
    } finally {
      setLoading(false);
    }
  }, [api, sourceFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async (body: KnowledgeCreateBody) => {
    setCreating(true);
    try {
      const entry = await api.create(body);
      setEntries((prev) => [entry, ...prev]);
      setShowNewForm(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create entry');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (id: string, body: KnowledgeCreateBody) => {
    const prev = entries;
    setEntries((rows) =>
      rows.map((r) =>
        r.id === id
          ? {
              ...r,
              title: body.title,
              description: body.description,
              body: body.body,
              intentTags: body.intentTags,
              sourceRef: body.sourceRef ?? null,
            }
          : r,
      ),
    );
    try {
      const updated = await api.update(id, body);
      setEntries((rows) => rows.map((r) => (r.id === id ? updated : r)));
      setError(null);
    } catch (err) {
      setEntries(prev);
      const msg = err instanceof Error ? err.message : 'Failed to update entry';
      setError(/BUNDLED_READONLY/i.test(msg)
        ? 'Bundled knowledge entries are read-only and cannot be edited.'
        : msg);
      throw err;
    }
  };

  const handleDelete = async (id: string) => {
    const prev = entries;
    setEntries((rows) => rows.filter((r) => r.id !== id));
    try {
      await api.remove(id);
      setError(null);
    } catch (err) {
      setEntries(prev);
      const msg = err instanceof Error ? err.message : 'Failed to delete entry';
      setError(/BUNDLED_READONLY/i.test(msg)
        ? 'Bundled knowledge entries are read-only and cannot be deleted.'
        : msg);
      throw err;
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start justify-between gap-3 p-3 rounded-lg border border-error/40 bg-error/10 text-sm text-error">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-error/70 hover:text-error"
          >
            ×
          </button>
        </div>
      )}

      {showNewForm && canWrite && (
        <KnowledgeEntryForm
          onSubmit={handleCreate}
          onCancel={() => setShowNewForm(false)}
          submitting={creating}
        />
      )}

      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-[var(--color-on-surface-variant)]">Source</label>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          className={selectCls + ' w-auto'}
        >
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === 'all' ? 'All' : s}</option>
          ))}
        </select>

        <div className="flex-1" />

        {canWrite && !showNewForm && (
          <button
            type="button"
            onClick={() => setShowNewForm(true)}
            aria-label="Add knowledge entry"
            title="Add knowledge entry"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-outline-variant)] text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors"
          >
            <span aria-hidden className="text-xl leading-none">+</span>
          </button>
        )}
      </div>

      <div className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] overflow-hidden">
        {loading ? (
          <div className="px-4 py-6 text-sm text-[var(--color-on-surface-variant)]">
            Loading entries…
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-sm text-[var(--color-on-surface-variant)]">
            No entries match this filter.
            {canWrite ? ' Add a knowledge entry to get started.' : ''}
          </div>
        ) : (
          entries.map((entry) => (
            <KnowledgeEntryRow
              key={entry.id}
              entry={entry}
              canWrite={canWrite}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}
