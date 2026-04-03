import React, { useState } from 'react';
import type { PanelConfig } from './DashboardPanelCard.js';

interface PanelQuery {
  refId: string;
  expr: string;
  legendFormat?: string;
  instant?: boolean;
}

interface Props {
  panel: PanelConfig;
  onSave: (updated: PanelConfig) => void;
  onCancel: () => void;
}

const VIZ_OPTIONS: Array<{ value: PanelConfig['visualization']; label: string; icon: string }> = [
  { value: 'time_series', label: 'Time Series', icon: 'T' },
  { value: 'stat', label: 'Stat', icon: 'S' },
  { value: 'gauge', label: 'Gauge', icon: 'G' },
  { value: 'bar', label: 'Bar', icon: 'B' },
  { value: 'table', label: 'Table', icon: 'Tb' },
  { value: 'heatmap', label: 'Heatmap', icon: 'H' },
  { value: 'pie', label: 'Pie', icon: 'P' },
  { value: 'histogram', label: 'Histogram', icon: 'Hi' },
  { value: 'status_timeline', label: 'Status Timeline', icon: 'St' },
];

const REF_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function getQueries(panel: PanelConfig): PanelQuery[] {
  if (panel.queries && panel.queries.length > 0) {
    return panel.queries.map((q) => ({
      refId: q.refId,
      expr: q.expr,
      legendFormat: q.legendFormat,
      instant: q.instant,
    }));
  }

  if (panel.query) {
    return [{ refId: 'A', expr: panel.query, legendFormat: undefined, instant: false }];
  }

  return [{ refId: 'A', expr: '', legendFormat: undefined, instant: false }];
}

export default function PanelEditor({ panel, onSave, onCancel }: Props) {
  const [title, setTitle] = useState(panel.title);
  const [description, setDescription] = useState(panel.description ?? '');
  const [visualization, setVisualization] = useState(panel.visualization);
  const [unit, setUnit] = useState(panel.unit ?? '');
  const [queries, setQueries] = useState<PanelQuery[]>(getQueries(panel));

  const updateQuery = (idx: number, patch: Partial<PanelQuery>) => {
    setQueries((prev) => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  };

  const addQuery = () => {
    const nextRef = REF_IDS[queries.length] ?? `Q${queries.length + 1}`;
    setQueries((prev) => [
      ...prev,
      { refId: nextRef, expr: '', legendFormat: undefined, instant: false },
    ]);
  };

  const removeQuery = (idx: number) => {
    if (queries.length === 1) return;
    setQueries((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...panel,
      title,
      description,
      visualization,
      unit: unit || undefined,
      queries: queries.map((q) => ({
        refId: q.refId,
        expr: q.expr,
        legendFormat: q.legendFormat,
        instant: q.instant,
      })),
      // Also update legacy field for backward compat
      query: queries[0]?.expr,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative z-10 bg-[#111118] rounded-2xl border border-[#2A2A3E] shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2A2A3E]">
          <h2 className="text-sm font-semibold text-[#E8E8ED]">Edit Panel</h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-[#1C1C2E] text-[#555570] hover:text-[#E8E8ED] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSave} className="flex flex-col flex-1 overflow-y-auto">
          <div className="px-6 py-4 space-y-5">
            <div className="grid gap-3">
              <div>
                <label className="block text-[11px] font-medium text-[#8888AA] uppercase tracking-wider mb-1.5">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#1C1C2E] border border-[#2A2A3E] text-sm text-[#E8E8ED] focus:outline-none focus:border-[#6366F1]/50 transition-colors"
                  placeholder="Panel title"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#8888AA] uppercase tracking-wider mb-1.5">Visualization</label>
                  <select
                    value={visualization}
                    onChange={(e) => setVisualization(e.target.value as PanelConfig['visualization'])}
                    className="w-full px-3 py-2 rounded-lg bg-[#1C1C2E] border border-[#2A2A3E] text-sm text-[#E8E8ED] focus:outline-none focus:border-[#6366F1]/50 transition-colors"
                  >
                    {VIZ_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#8888AA] uppercase tracking-wider mb-1.5">Unit</label>
                  <input
                    type="text"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#1C1C2E] border border-[#2A2A3E] text-sm text-[#E8E8ED] focus:outline-none focus:border-[#6366F1]/50 transition-colors"
                    placeholder="ms, %, req/s..."
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8888AA] uppercase tracking-wider mb-1.5">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#1C1C2E] border border-[#2A2A3E] text-sm text-[#E8E8ED] focus:outline-none focus:border-[#6366F1]/50 transition-colors"
                  placeholder="Short description (optional)"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-[11px] font-medium text-[#8888AA] uppercase tracking-wider">Queries</label>
                  <button
                    type="button"
                    onClick={addQuery}
                    className="flex items-center gap-1 text-[11px] text-[#6366F1] hover:text-[#818CF8] transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m7-7H5" />
                    </svg>
                    Add query
                  </button>
                </div>

                <div className="space-y-3">
                  {queries.map((q, idx) => (
                    <div key={idx} className="rounded-xl bg-[#0A0A0F] border border-[#2A2A3E] overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1E1E2E]">
                        <span className="w-5 h-5 rounded bg-[#6366F1]/20 text-[#818CF8] text-[10px] font-bold flex items-center justify-center">
                          {q.refId}
                        </span>
                        <span className="flex-1 text-[11px] text-[#555570]">PromQL</span>

                        <button
                          type="button"
                          onClick={() => updateQuery(idx, { instant: !q.instant })}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            q.instant
                              ? 'bg-[#6366F1]/20 text-[#818CF8]'
                              : 'bg-[#1C1C2E] text-[#555570] hover:text-[#8888AA]'
                          }`}
                        >
                          {q.instant ? 'Instant' : 'Range'}
                        </button>

                        {queries.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeQuery(idx)}
                            className="p-1 rounded text-[#555570] hover:text-[#EF5149] hover:bg-[#EF5149]/10 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>

                      <textarea
                        value={q.expr}
                        onChange={(e) => updateQuery(idx, { expr: e.target.value })}
                        rows={3}
                        spellCheck={false}
                        className="w-full bg-transparent px-3 py-2.5 text-sm text-[#E8E8ED] placeholder:text-[#444454] focus:outline-none resize-none leading-relaxed"
                        placeholder="rate(http_requests_total[5m])"
                      />

                      <div className="flex items-center gap-2 px-3 py-2 border-t border-[#1E1E2E]">
                        <span className="text-[10px] text-[#555570] shrink-0">Legend</span>
                        <input
                          type="text"
                          value={q.legendFormat ?? ''}
                          onChange={(e) => updateQuery(idx, { legendFormat: e.target.value || undefined })}
                          className="flex-1 bg-transparent text-[12px] text-[#8888AA] focus:text-[#E8E8ED] focus:outline-none"
                          placeholder="{{ label }}"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#2A2A3E] bg-[#0A0A0F]">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-[#8888AA] hover:text-[#E8E8ED] rounded-lg hover:bg-[#1C1C2E] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-[#6366F1] text-white text-sm font-medium rounded-lg hover:bg-[#818CF8] transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
