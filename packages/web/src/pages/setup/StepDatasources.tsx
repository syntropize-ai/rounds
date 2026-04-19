import React, { useState } from 'react';
import { apiClient } from '../../api/client.js';
import { datasourceUrlPlaceholder } from '../../constants/placeholders.js';
import { DATASOURCE_TYPES } from '../../constants/datasource-types.js';
import type { DatasourceEntry } from './types.js';

function newEntryId(): string {
  // Stable id per entry. crypto.randomUUID is available in all modern
  // browsers served by vite; fall back to a random-enough string otherwise.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ds-${crypto.randomUUID()}`;
  }
  return `ds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function blankForm(): DatasourceEntry {
  // Default to prometheus — it's currently the only type with a backend
  // adapter wired. Other types are still selectable but disabled in the UI.
  return { id: newEntryId(), type: 'prometheus', name: '', url: '', apiKey: '' };
}

export function StepDatasources({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [entries, setEntries] = useState<DatasourceEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [form, setForm] = useState<DatasourceEntry>(blankForm);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [saving, setSaving] = useState(false);

  const openNewForm = () => {
    setForm(blankForm());
    setEditingIdx(null);
    setAdding(true);
  };

  const resetForm = () => {
    setForm(blankForm());
    setAdding(false);
    setEditingIdx(null);
  };

  const handleAdd = async () => {
    if (!form.url || saving) return;
    setSaving(true);
    // Reuse the id minted when the form opened. Edits preserve the
    // existing entry's id; in edit mode we PUT, in create mode we POST.
    const payload: DatasourceEntry = {
      ...form,
      name: form.name || form.type,
    };
    if (editingIdx !== null && form.id) {
      await apiClient.put(`/datasources/${form.id}`, payload);
      setEntries((prev) => prev.map((d, i) => (i === editingIdx ? payload : d)));
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[editingIdx];
        return next;
      });
    } else {
      await apiClient.post('/datasources', payload);
      setEntries((prev) => [...prev, payload]);
    }
    resetForm();
    setSaving(false);
  };

  const handleEdit = (idx: number) => {
    const ds = entries[idx];
    if (!ds) return;
    setForm({
      id: ds.id,
      type: ds.type,
      name: ds.name,
      url: ds.url,
      apiKey: ds.apiKey ?? '',
    });
    setEditingIdx(idx);
    setAdding(true);
  };

  const handleTest = async (idx: number) => {
    const ds = entries[idx];
    // /api/datasources/test is the test-only endpoint — no persistence.
    const res = await apiClient.post<{ ok: boolean; message: string }>(
      '/datasources/test',
      ds,
    );
    setTestResults((prev) => ({
      ...prev,
      [idx]: res.error ? { ok: false, message: res.error.message } : res.data,
    }));
  };

  const categories = ['Logs', 'Traces', 'Metrics'];

  return (
    <div>
      <h2 className="text-xl font-bold text-[var(--color-on-surface)] mb-1">Data Sources</h2>
      <p className="text-[var(--color-on-surface-variant)] text-sm mb-6">Connect your observability backends. You can add more later in Settings.</p>

      {entries.length > 0 && (
        <div className="space-y-2 mb-4">
          {entries.map((ds, i) => (
            <div key={i} className="rounded-lg bg-[var(--color-surface-high)] border border-[var(--color-outline-variant)]">
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="text-xs font-mono bg-[var(--color-surface-lowest)] border border-[var(--color-outline-variant)] rounded px-2 py-1 text-[var(--color-on-surface-variant)] shrink-0">
                  {ds.type}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[var(--color-on-surface)] truncate">
                    {ds.name || ds.type}
                  </div>
                  <div className="text-xs text-[var(--color-on-surface-variant)] truncate font-mono">
                    {ds.url}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleTest(i)}
                  className="text-xs text-[var(--color-primary)] hover:opacity-80 font-medium shrink-0"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => handleEdit(i)}
                  className="text-xs text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)] shrink-0"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEntries((prev) => prev.filter((_, j) => j !== i));
                    setTestResults((prev) => {
                      const next = { ...prev };
                      delete next[i];
                      return next;
                    });
                  }}
                  className="text-xs text-[var(--color-error)] hover:opacity-80 shrink-0"
                >
                  Remove
                </button>
              </div>
              {testResults[i] && (
                <div className={`mx-4 mb-3 px-3 py-2 rounded text-xs ${
                  testResults[i].ok
                    ? 'bg-secondary/10 text-secondary border border-secondary/30'
                    : 'bg-error/10 text-error border border-error/30'
                }`}>
                  {testResults[i].ok ? '✓ ' : '✗ '}
                  {testResults[i].message}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="border border-[var(--color-outline-variant)] rounded-xl bg-[var(--color-surface-highest)] p-4 space-y-3 mb-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              >
                {categories.map((cat) => (
                  <optgroup key={cat} label={cat}>
                    {DATASOURCE_TYPES.filter((d) => d.category === cat).map((d) => (
                      <option key={d.value} value={d.value} disabled={!d.supported}>
                        {d.label}{d.supported ? '' : ' — coming soon'}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-xs text-[var(--color-on-surface-variant)] mt-1">
                Only Prometheus + VictoriaMetrics are wired to a backend adapter today. Other types are stubbed and will land as we add adapters.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Name (optional)</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="prod-loki"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">URL</label>
              <input
                type="url"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder={datasourceUrlPlaceholder(form.type)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">API Key (optional)</label>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="password"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={!form.url || saving}
              className="px-4 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {saving ? (editingIdx !== null ? 'Saving...' : 'Adding...') : (editingIdx !== null ? 'Save' : 'Add')}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 text-sm text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={openNewForm}
        className="w-full py-3 rounded-xl border-2 border-dashed border-[var(--color-outline-variant)] text-sm text-[var(--color-on-surface-variant)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors mb-4"
      >
        + Add data source
      </button>

      <div className="flex justify-between mt-6">
        <button type="button" onClick={onBack} className="px-5 py-2 text-sm font-medium text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">
          ← Back
        </button>
        <div className="flex gap-3">
          <button type="button" onClick={onNext} className="px-5 py-2 text-sm text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">
            Skip for now
          </button>
          <button
            type="button"
            onClick={onNext}
            className="px-5 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}
