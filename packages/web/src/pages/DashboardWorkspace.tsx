import React, { useEffect, useState, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import { queryScheduler } from '../api/query-scheduler.js';
import DashboardGrid from '../components/DashboardGrid.js';
import PanelEditor from '../components/PanelEditor.js';
import ChatPanel from '../components/ChatPanel.js';
import VariableBar from '../components/VariableBar.js';
import InvestigationReportView from '../components/InvestigationReportView.js';
import { useDashboardChat } from '../hooks/useDashboardChat.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import type { PanelConfig } from '../components/DashboardPanelCard.js';
import type { DashboardVariable } from '../hooks/useDashboardChat.js';

// Types

interface Dashboard {
  id: string;
  title: string;
  description?: string;
  prompt: string;
  status: 'generating' | 'ready' | 'error';
  type?: string;
  panels: PanelConfig[];
  variables?: DashboardVariable[];
  createdAt: string;
  updatedAt?: string;
  folder?: string;
}

// Time Range Picker

const QUICK_RANGES = [
  { value: '5m', label: 'Last 5 min' },
  { value: '15m', label: 'Last 15 min' },
  { value: '30m', label: 'Last 30 min' },
  { value: '1h', label: 'Last 1 hour' },
  { value: '3h', label: 'Last 3 hours' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '12h', label: 'Last 12 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '2d', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
];

function TimeRangePicker({ value, onChange, onRefresh }: {
  value: string;
  onChange: (v: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [customFrom, setCustomFrom] = React.useState('');
  const [customTo, setCustomTo] = React.useState('');
  const ref = React.useRef<HTMLDivElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    if (open) { document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler); }
  }, [open]);

  React.useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [open]);

  const displayLabel = QUICK_RANGES.find((r) => r.value === value)?.label
    ?? (value.includes('|') ? 'Custom' : value);

  const applyCustom = () => {
    if (customFrom && customTo) {
      onChange(`${customFrom}|${customTo}`);
      setOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-surface-high text-on-surface text-xs rounded-lg px-3 py-1.5 hover:bg-surface-bright transition-colors"
      >
        <svg className="w-3.5 h-3.5 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {displayLabel}
        <svg className="w-3 h-3 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && ReactDOM.createPortal(
        <div ref={ref} className="fixed bg-surface-highest rounded-xl shadow-2xl shadow-black/40 min-w-[260px] py-2" style={{ top: pos.top, left: pos.left, zIndex: 9999 }}>
            <p className="px-3 py-1 text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Quick ranges</p>
            <div className="grid grid-cols-2 gap-0.5 px-2">
              {QUICK_RANGES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => { onChange(r.value); setOpen(false); }}
                  className={`text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    value === r.value ? 'bg-primary/15 text-primary' : 'text-on-surface hover:bg-surface-bright'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div className="border-t border-outline-variant/20 mt-2 pt-2 px-3">
              <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-2">Custom range</p>
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] text-on-surface-variant mb-0.5 block">From</label>
                  <input
                    type="datetime-local"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="w-full bg-surface-high text-on-surface text-xs rounded-lg px-2.5 py-1.5 border-none focus:ring-1 focus:ring-primary"
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
                <div>
                  <label className="text-[10px] text-on-surface-variant mb-0.5 block">To</label>
                  <input
                    type="datetime-local"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="w-full bg-surface-high text-on-surface text-xs rounded-lg px-2.5 py-1.5 border-none focus:ring-1 focus:ring-primary"
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
                <button
                  type="button"
                  onClick={applyCustom}
                  disabled={!customFrom || !customTo}
                  className="w-full bg-primary text-on-primary-fixed text-xs font-semibold rounded-lg py-1.5 disabled:opacity-40 transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>,
        document.body,
      )}

      <button
        type="button"
        onClick={onRefresh}
        className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors"
        title="Refresh"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m14.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0A8.003 8.003 0 015.163 13M15 15h5" />
        </svg>
      </button>
    </div>
  );
}

// Move to Folder Dialog

function FolderDialog({ dashboardId, currentFolder, onSaved, open, onClose }: {
  dashboardId: string; currentFolder?: string; onSaved: (folder: string) => void; open: boolean; onClose: () => void;
}) {
  const [folders, setFolders] = React.useState<Array<{ id: string; name: string; parentId?: string }>>([]);
  const [selected, setSelected] = React.useState(currentFolder || '');
  const [creatingNew, setCreatingNew] = React.useState(false);
  const [newFolder, setNewFolder] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setSelected(currentFolder || '');
    setCreatingNew(false);
    setNewFolder('');
    void apiClient.get<Array<{ id: string; name: string; parentId?: string }>>('/folders').then((res) => {
      if (!res.error) setFolders(res.data);
    });
  }, [open, currentFolder]);

  React.useEffect(() => {
    if (creatingNew) setTimeout(() => inputRef.current?.focus(), 50);
  }, [creatingNew]);

  const save = async () => {
    const res = await apiClient.put<Dashboard>(`/dashboards/${dashboardId}`, { folder: selected || undefined });
    if (!res.error) onSaved(selected);
    onClose();
  };

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-surface-highest rounded-2xl shadow-2xl w-80 max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="text-sm font-bold text-on-surface font-[Manrope]">Move to folder</h3>
          <button type="button" onClick={onClose} className="p-1 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto px-3 pb-2">
          {/* General */}
          <button type="button" onClick={() => setSelected('')}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-left transition-colors ${selected === '' ? 'bg-primary/10 text-primary' : 'text-on-surface hover:bg-surface-bright'}`}>
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" /></svg>
            General
            {selected === '' && <svg className="w-4 h-4 ml-auto" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
          </button>

          {folders.map((f) => (
            <button key={f.id} type="button" onClick={() => setSelected(f.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-left transition-colors ${selected === f.id ? 'bg-primary/10 text-primary' : 'text-on-surface hover:bg-surface-bright'}`}
              style={{ paddingLeft: f.parentId ? 36 : undefined }}>
              <svg className="w-5 h-5 shrink-0 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
              <span className="flex-1 truncate">{f.name}</span>
              {selected === f.id && <svg className="w-4 h-4 ml-auto" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
            </button>
          ))}

          {/* New folder inline */}
          {creatingNew ? (
            <div className="flex items-center gap-2 px-3 py-2">
              <svg className="w-5 h-5 shrink-0 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
              <input ref={inputRef} type="text" value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newFolder.trim()) {
                    void apiClient.post<{ id: string; name: string }>('/folders', { name: newFolder.trim() }).then((res) => {
                      if (!res.error) {
                        setFolders((prev) => [...prev, res.data]);
                        setSelected(res.data.id);
                      }
                    });
                    setCreatingNew(false);
                  }
                  if (e.key === 'Escape') setCreatingNew(false);
                }}
                placeholder="Folder name"
                className="flex-1 bg-surface-high text-on-surface text-sm rounded-lg px-2.5 py-1.5 border-none focus:ring-1 focus:ring-primary outline-none" />
            </div>
          ) : (
            <button type="button" onClick={() => setCreatingNew(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors text-left">
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
              New folder
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-outline-variant/20">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface rounded-lg hover:bg-surface-bright transition-colors">
            Cancel
          </button>
          <button type="button" onClick={() => void save()}
            className="px-4 py-2 text-sm font-semibold bg-primary text-on-primary-fixed rounded-lg transition-transform active:scale-95">
            Move
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Export format converters

function toGrafana(dash: Dashboard): unknown {
  return {
    __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', type: 'datasource', pluginId: 'prometheus' }],
    title: dash.title,
    description: dash.description ?? '',
    tags: ['prism-export'],
    timezone: 'browser',
    editable: true,
    panels: (dash.panels ?? []).map((p, i) => ({
      id: i + 1,
      title: p.title,
      description: p.description ?? '',
      type: p.visualization === 'time_series' ? 'timeseries'
        : p.visualization === 'stat' ? 'stat'
        : p.visualization === 'gauge' ? 'gauge'
        : p.visualization === 'bar' ? 'barchart'
        : p.visualization === 'pie' ? 'piechart'
        : p.visualization === 'table' ? 'table'
        : p.visualization === 'heatmap' ? 'heatmap'
        : p.visualization === 'histogram' ? 'histogram'
        : 'timeseries',
      gridPos: { h: p.height ?? 8, w: p.width ?? 12, x: p.col ?? 0, y: p.row ?? 0 },
      targets: (p.queries ?? []).map((q, qi) => ({
        refId: q.refId || String.fromCharCode(65 + qi),
        expr: q.expr,
        legendFormat: q.legendFormat ?? '',
        datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
        instant: q.instant ?? false,
      })),
      fieldConfig: { defaults: { unit: p.unit ?? 'short' } },
      datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
    })),
    templating: { list: (dash.variables ?? []).map((v) => ({
      name: v.name, label: v.label ?? v.name, type: 'query', query: v.query ?? '',
      multi: false, includeAll: false,
    })) },
    time: { from: 'now-1h', to: 'now' },
    refresh: '30s',
    schemaVersion: 39,
    version: 1,
  };
}

function toPrometheusRules(dash: Dashboard): string {
  const rules = (dash.panels ?? [])
    .flatMap((p) => (p.queries ?? []).map((q) => ({
      record: `prism:${p.title.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()}`,
      expr: q.expr,
    })));
  return `groups:\n  - name: ${dash.title.replace(/[^a-zA-Z0-9_ -]/g, '')}\n    rules:\n${rules.map((r) => `      - record: ${r.record}\n        expr: ${r.expr}`).join('\n')}`;
}

function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ExportMenu({ dashboard }: { dashboard: Dashboard }) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ top: 0, right: 0 });

  React.useEffect(() => {
    if (!open) return;
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const slug = dashboard.title.replace(/[^a-zA-Z0-9_-]/g, '_');
  const formats = [
    { label: 'Prism JSON', desc: 'Native format', onClick: () => { downloadFile(JSON.stringify(dashboard, null, 2), `${slug}.json`, 'application/json'); setOpen(false); } },
    { label: 'Grafana JSON', desc: 'Import into Grafana', onClick: () => { downloadFile(JSON.stringify(toGrafana(dashboard), null, 2), `${slug}_grafana.json`, 'application/json'); setOpen(false); } },
    { label: 'Prometheus Rules', desc: 'Recording rules YAML', onClick: () => { downloadFile(toPrometheusRules(dashboard), `${slug}_rules.yml`, 'text/yaml'); setOpen(false); } },
  ];

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(!open)}
        className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors" title="Export">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </button>
      {open && ReactDOM.createPortal(
        <div ref={menuRef} className="fixed w-56 bg-surface-highest rounded-xl shadow-2xl shadow-black/40 py-1" style={{ top: pos.top, right: pos.right, zIndex: 9999 }}>
          <p className="px-3 py-1.5 text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Export as</p>
          {formats.map((f) => (
            <button key={f.label} type="button" onClick={f.onClick}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-bright transition-colors">
              <div className="flex-1">
                <div className="text-sm text-on-surface">{f.label}</div>
                <div className="text-[10px] text-on-surface-variant">{f.desc}</div>
              </div>
              <svg className="w-4 h-4 text-on-surface-variant shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// Main

export default function DashboardWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const initialPrompt = (location.state as { initialPrompt?: string } | null)?.initialPrompt;
  const initialPromptSent = useRef(false);

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [timeRange, setTimeRange] = useState('1h');
  const [editingPanel, setEditingPanel] = useState<PanelConfig | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showFolderDialog, setShowFolderDialog] = useState(false);

  // pollRef removed — no more polling; SSE pushes all updates
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Load dashboard
  const dashboardLoadedRef = useRef(false);

  const loadDashboard = useCallback(async () => {
    if (!id) return;
    const res = await apiClient.get<Dashboard>(`/dashboards/${id}`);
    const errStatus = Number((res.error as Record<string, unknown> | undefined)?.status);
    const isTransient =
      !!res.error && (res.error.code === 'RATE_LIMITED' || (!Number.isNaN(errStatus) && errStatus >= 500));

    if (isTransient) {
      if (dashboardLoadedRef.current) {
        retryCountRef.current = 0;
        return;
      }

      if (retryCountRef.current < 8) {
        const delayMs = Math.min(1000 * 2 ** retryCountRef.current, 30000);
        retryCountRef.current += 1;
        retryTimerRef.current = setTimeout(() => {
          void loadDashboard();
        }, delayMs);
        return;
      }
    }

    retryCountRef.current = 0;
    if (res.error) {
      if (!dashboardLoadedRef.current) {
        setLoadError(res.error.message ?? 'Failed to load dashboard');
      }
    } else {
      dashboardLoadedRef.current = true;
      setDashboard(res.data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    retryCountRef.current = 0;
    void loadDashboard();
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [loadDashboard]);

  // Chat / SSE
  const {
    events,
    isGenerating,
    sendMessage,
    stopGeneration,
    panels,
    variables,
    setPanels,
    setVariables,
    investigationReport,
  } = useDashboardChat(id ?? '', dashboard?.panels ?? [], dashboard?.variables ?? []);
  const [showReport, setShowReport] = useState(false);

  // Auto-show investigation report when it arrives
  useEffect(() => {
    if (investigationReport) setShowReport(true);
  }, [investigationReport]);

  // Auto-send initial prompt from Home page
  useEffect(() => {
    if (initialPrompt && dashboard && !initialPromptSent.current && !isGenerating) {
      initialPromptSent.current = true;
      if (location.state) {
        window.history.replaceState({}, '');
      }
      void sendMessage(initialPrompt);
    }
  }, [initialPrompt, dashboard, isGenerating, sendMessage]);

  // Reload dashboard once when generation completes (SSE done → isGenerating becomes false)
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating && id) {
      // Generation just finished — fetch final dashboard state once
      void apiClient.get<Dashboard>(`/dashboards/${id}`).then((res) => {
        if (!res.error && res.data) setDashboard(res.data);
      });
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating, id]);

  // Variable changes
  const handleVariableChange = useCallback((name: string, value: string) => {
    setVariables((prev) =>
      prev.map((v) => (v.name === name ? { ...v, current: value } : v))
    );
  }, [setVariables]);

  // Title editing

  const startEditTitle = () => {
    setTitleDraft(dashboard?.title ?? '');
    setEditingTitle(true);
  };

  const saveTitle = async () => {
    if (!id || !titleDraft.trim()) return;
    const res = await apiClient.put<Dashboard>(`/dashboards/${id}`, {
      title: titleDraft.trim(),
    });
    if (!res.error) setDashboard(res.data);
    setEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void saveTitle();
    if (e.key === 'Escape') setEditingTitle(false);
  };

  // Panel CRUD

  const handleSavePanel = async (updated: PanelConfig) => {
    if (!id || !dashboard) return;
    const newPanels = panels.map((p) => (p.id === updated.id ? updated : p));
    const res = await apiClient.put<Dashboard>(`/dashboards/${id}/panels`, newPanels);
    if (!res.error) {
      setDashboard(res.data);
      setPanels(res.data.panels);
    }
    setEditingPanel(null);
  };

  const handleDeletePanel = async (panelId: string) => {
    if (!id) return;
    const res = await apiClient.delete<Dashboard>(`/dashboards/${id}/panels/${panelId}`);
    if (!res.error) {
      setDashboard(res.data);
      setPanels(res.data.panels);
    }
  };

  const handleAddPanel = async () => {
    if (!id) return;
    const newPanel: Omit<PanelConfig, 'id'> = {
      title: 'New Panel',
      description: '',
      queries: [],
      query: '',
      visualization: 'time_series',
      refreshIntervalSec: 30,
    };
    const res = await apiClient.post<Dashboard>(`/dashboards/${id}/panels`, newPanel);
    if (!res.error) {
      setDashboard(res.data);
      setPanels(res.data.panels);
      const lastPanel = res.data.panels[res.data.panels.length - 1];
      if (lastPanel) setEditingPanel(lastPanel);
    }
  };

  // Layout change

  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLayoutChange = useCallback(
    (newLayout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => {
      if (!id || !panels) return;
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = setTimeout(() => {
        const updatedPanels = panels.map((panel) => {
          const item = newLayout.find((l) => l.i === panel.id);
          if (!item) return panel;
          return {
            ...panel,
            col: item.x,
            row: item.y,
            width: item.w,
            height: item.h,
          };
        });

        void apiClient.put<Dashboard>(`/dashboards/${id}/panels`, { panels: updatedPanels }).then((res) => {
          if (!res.error) {
            setDashboard(res.data);
            setPanels(res.data.panels);
          }
        });
      }, 500);
    },
    [id, panels, setPanels]
  );

  // Scroll to panel
  const scrollToPanel = useCallback((panelId: string) => {
    const el = document.getElementById(`panel-${panelId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Loading / error states
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface">
        <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError || !dashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-surface text-center px-6">
        <p className="text-error text-sm mb-4">{loadError ?? 'Dashboard not found.'}</p>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-sm text-primary hover:text-primary-container transition-colors"
        >
          Back to Dashboards
        </button>
      </div>
    );
  }

  // Render

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface">
      <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 bg-surface/80 backdrop-blur-xl">
        <button
          type="button"
          onClick={() => navigate(dashboard?.type === 'investigation' ? '/investigations' : '/dashboards')}
          className="p-1.5 rounded-lg hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors shrink-0"
          aria-label="Back to dashboards"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M12.707 14.707a1 1 0 01-1.414 0L6.586 10l4.707-4.707a1 1 0 111.414 1.414L9.414 10l3.293 3.293a1 1 0 010 1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <div className="flex-1 min-w-0 flex items-center gap-2">
          {isGenerating && dashboard.title === 'Untitled Dashboard' ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
              <span className="text-sm text-on-surface-variant truncate italic">
                {dashboard.prompt?.length > 50 ? `${dashboard.prompt.slice(0, 50)}...` : dashboard.prompt}
              </span>
            </div>
          ) : showReport ? (
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197M4.7 10a5.3 5.3 0 1010.6 0 5.3 5.3 0 00-10.6 0z" />
              </svg>
              <span className="text-sm font-semibold text-on-surface truncate">
                {dashboard.title.startsWith('Investigation') ? dashboard.title : 'Investigation'}
              </span>
            </div>
          ) : editingTitle ? (
            <input
              autoFocus
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                void saveTitle();
              }}
              onKeyDown={handleTitleKeyDown}
              className="text-sm font-semibold text-on-surface bg-transparent border-b border-primary focus:outline-none w-full"
            />
          ) : (
            <button
              type="button"
              onClick={startEditTitle}
              className="text-sm font-semibold text-on-surface hover:text-primary-container truncate text-left max-w-xs transition-colors"
              title="Click to rename"
            >
              {dashboard.title}
            </button>
          )}

          {!showReport && !isGenerating && dashboard.folder && (
            <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
              {dashboard.folder}
            </span>
          )}
        </div>

        {/* Center: time range + refresh */}
        {!showReport && !isGenerating && (
          <TimeRangePicker
            value={timeRange}
            onChange={(v) => {
              setTimeRange(v);
              queryScheduler.clearCache();
              window.dispatchEvent(new CustomEvent('dashboard:refresh-panels'));
            }}
            onRefresh={() => {
              queryScheduler.clearCache();
              window.dispatchEvent(new CustomEvent('dashboard:refresh-panels'));
            }}
          />
        )}

        {!showReport && (
          <>
            {/* Edit toggle */}
            <button
              type="button"
              onClick={() => setEditMode((v) => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                editMode
                  ? 'bg-primary text-on-primary-fixed'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-high'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              {editMode ? 'Editing' : 'Edit'}
            </button>

            {/* Add panel (only in edit mode) */}
            {editMode && (
              <button
                type="button"
                onClick={() => void handleAddPanel()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Add Panel
              </button>
            )}

            {/* Export */}
            <ExportMenu dashboard={dashboard} />

            {id && (
              <button
                type="button"
                onClick={() => setShowFolderDialog(true)}
                className="p-1.5 rounded-lg transition-colors hover:bg-surface-high text-on-surface-variant hover:text-on-surface"
                title={dashboard.folder ? `Folder: ${dashboard.folder}` : 'Move to folder'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="group relative p-2 rounded-lg text-on-surface-variant hover:text-error hover:bg-surface-high transition-colors shrink-0"
              title="Delete"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
              </svg>
            </button>
          </>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <VariableBar
            dashboardId={id ?? ''}
            variables={variables}
            onChange={handleVariableChange}
          />

          {showReport && investigationReport ? (
            <InvestigationReportView
              report={investigationReport}
              onClose={() => setShowReport(false)}
            />
          ) : (
            <div className="flex-1 overflow-y-auto overscroll-contain p-6 bg-surface-container">
              <DashboardGrid
                panels={panels}
                editMode={editMode}
                isGenerating={isGenerating}
                timeRange={timeRange}
                onEditPanel={(panelId) => {
                  const p = panels.find((x) => x.id === panelId);
                  if (p) setEditingPanel(p);
                }}
                onDeletePanel={(panelId) => {
                  void handleDeletePanel(panelId);
                }}
                onLayoutChange={handleLayoutChange}
              />
            </div>
          )}

          <div className="shrink-0 px-6 py-2 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${isGenerating ? 'bg-primary animate-pulse' : 'bg-secondary'}`} />
            <span className="text-xs text-on-surface-variant">
              {isGenerating ? 'Generating...' : `${panels.length} panel${panels.length !== 1 ? 's' : ''} ready`}
            </span>
          </div>
        </div>

        <ChatPanel
          events={events}
          isGenerating={isGenerating}
          onSendMessage={(msg) => {
            void sendMessage(msg);
          }}
          onStop={stopGeneration}
        />
      </div>

      {editingPanel && (
        <PanelEditor
          panel={editingPanel}
          onSave={(updated) => {
            void handleSavePanel(updated);
          }}
          onCancel={() => setEditingPanel(null)}
        />
      )}

      {id && (
        <FolderDialog
          dashboardId={id}
          currentFolder={dashboard?.folder}
          open={showFolderDialog}
          onClose={() => setShowFolderDialog(false)}
          onSaved={(folder) => setDashboard((prev) => (prev ? { ...prev, folder } : prev))}
        />
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete dashboard?"
        message="This dashboard and all its panels will be permanently deleted."
        onConfirm={async () => {
          if (id) {
            const res = await apiClient.delete(`/dashboards/${id}`);
            if (!res.error) navigate(dashboard?.type === 'investigation' ? '/investigations' : '/dashboards');
          }
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
