import React, { useState } from 'react';
import { apiClient } from '../../api/client.js';
import { datasourceUrlPlaceholder } from '../../constants/placeholders.js';
import { DATASOURCE_TYPES } from './types.js';
import type { DatasourceEntry } from './types.js';

export function StepDatasources({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [entries, setEntries] = useState<DatasourceEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<DatasourceEntry>({ type: 'loki', name: '', url: '', apiKey: '' });
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!form.url) return;
    setSaving(true);
    await apiClient.post('/setup/datasource', {
      datasource: {
        ...form,
        id: `${Date.now()}`,
        name: form.name || form.type,
      },
    });
    setEntries((prev) => [...prev, form]);
    setForm({ type: 'loki', name: '', url: '', apiKey: '' });
    setAdding(false);
    setSaving(false);
  };

  const handleTest = async (idx: number) => {
    const ds = entries[idx];
    const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/datasource', {
      datasource: ds,
      test: true,
    });
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
            <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--color-surface-high)] border border-[var(--color-outline-variant)]">
              <span className="text-xs font-mono bg-[var(--color-surface-lowest)] border border-[var(--color-outline-variant)] rounded px-2 py-1 text-[var(--color-on-surface-variant)]">
                {ds.type}
              </span>
              <span className="text-sm text-[var(--color-on-surface)] flex-1">
                {ds.name || ds.url}
              </span>
              <button
                type="button"
                onClick={() => void handleTest(i)}
                className="text-xs text-[var(--color-primary)] hover:text-[var(--color-primary)] font-medium"
              >
                Test
              </button>
              {testResults[i] && (
                <span className={`text-xs font-medium ${testResults[i].ok ? 'text-secondary' : 'text-error'}`}>
                  {testResults[i].ok ? '✓ ' : '✗ '}
                  {testResults[i].message}
                </span>
              )}
              <button
                type="button"
                onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
                className="text-xs text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]"
              >
                Remove
              </button>
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
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
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
              {saving ? 'Adding...' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-4 py-2 text-sm text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdding(true)}
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
