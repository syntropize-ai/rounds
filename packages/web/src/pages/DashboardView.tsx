import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import DashboardGrid from '../components/DashboardGrid.js';
import PanelEditor from '../components/PanelEditor.js';
import type { PanelConfig } from '../components/DashboardPanelCard.js';

// Types

interface Dashboard {
  id: string;
  title: string;
  description?: string;
  status: 'generating' | 'ready' | 'error';
  panels: PanelConfig[];
  createdAt: string;
  updatedAt: string;
}

// Refresh interval options

const REFRESH_OPTIONS = [
  { label: 'Off', value: null as null },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
];

// Generating indicator

function GeneratingBanner() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
      <span className="inline-block w-5 h-5 border-2 border-amber-200 border-t-amber-500 rounded-full animate-spin shrink-0" />
      <div>Generating dashboard panels. This may take a moment...</div>
    </div>
  );
}

// Main

export default function DashboardView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editingPanel, setEditingPanel] = useState<PanelConfig | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(30);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!id) return;
    const res = await apiClient.get<Dashboard>(`/dashboards/${id}`);
    if (res.error) {
      setError(res.error.message ?? 'Failed to load dashboard');
    } else {
      setDashboard(res.data);
    }
    setLoading(false);
  }, [id]);

  // Initial load + poll while generating
  useEffect(() => {
    setLoading(true);
    setError(null);
    setDashboard(null);
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (dashboard?.status === 'generating') {
      pollRef.current = setInterval(() => {
        void loadDashboard();
      }, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [dashboard?.status, loadDashboard]);

  // Title editing

  const startEditTitle = () => {
    setTitleDraft(dashboard?.title ?? '');
    setEditingTitle(true);
  };

  const saveTitle = async () => {
    if (!id || !titleDraft.trim()) return;
    const res = await apiClient.put<Dashboard>(`/dashboards/${id}`, { title: titleDraft.trim() });
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
    const newPanels = dashboard.panels.map((p) => (p.id === updated.id ? updated : p));
    const res = await apiClient.put<Dashboard>(`/dashboards/${id}/panels`, newPanels);
    if (!res.error) setDashboard(res.data);
    setEditingPanel(null);
  };

  const handleDeletePanel = async (panelId: string) => {
    if (!id) return;
    const res = await apiClient.delete<Dashboard>(`/dashboards/${id}/panels/${panelId}`);
    if (!res.error) setDashboard(res.data);
  };

  const handleAddPanel = async () => {
    if (!id) return;
    const newPanel: Omit<PanelConfig, 'id'> = {
      title: 'New Panel',
      description: '',
      queries: [],
      query: '',
      visualization: 'time_series',
      refreshIntervalSec: refreshInterval,
    };
    const res = await apiClient.post<Dashboard>(`/dashboards/${id}/panels`, newPanel);
    if (!res.error) {
      setDashboard(res.data);
      const lastPanel = res.data.panels[res.data.panels.length - 1];
      if (lastPanel) setEditingPanel(lastPanel);
    }
  };

  // Layout change (drag / resize)

  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLayoutChange = useCallback(
    (newLayout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => {
      if (!id || !dashboard) return;

      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);

      layoutTimerRef.current = setTimeout(() => {
        const updatedPanels = dashboard.panels.map((panel) => {
          const item = newLayout.find((l) => l.i === panel.id);
          if (!item) return panel;
          return {
            ...panel,
            gridCol: item.x + 1,
            gridRow: item.y,
            gridWidth: item.w,
            gridHeight: item.h,
          };
        });

        void apiClient
          .put<Dashboard>(`/dashboards/${id}/panels`, updatedPanels)
          .then((res) => {
            if (!res.error) setDashboard(res.data);
          });
      }, 500);
    },
    [id, dashboard]
  );

  // Apply global refresh interval to all panels

  const applyRefreshInterval = async (newInterval: number | null) => {
    setRefreshInterval(newInterval);
    if (!id || !dashboard) return;
    const updated = dashboard.panels.map((p) => ({
      ...p,
      refreshIntervalSec: newInterval ?? undefined,
    }));
    const res = await apiClient.put<Dashboard>(`/dashboards/${id}/panels`, updated);
    if (!res.error) setDashboard(res.data);
  };

  // Render

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-24">
        <div className="inline-block w-6 h-6 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="max-w-2xl mx-auto p-6 py-12 text-center">
        <p className="text-red-500 text-sm">Error: {error ?? 'Dashboard not found.'}</p>
        <button
          type="button"
          onClick={() => navigate('/dashboards')}
          className="mt-4 text-sm text-indigo-600 hover:text-indigo-500"
        >
          Back to Dashboards
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-4 flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={() => navigate('/dashboards')}
          className="text-slate-500 hover:text-slate-800 transition-colors shrink-0"
          aria-label="Back to dashboards"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M12.707 14.707a1 1 0 01-1.414 0L6.586 10l4.707-4.707a1 1 0 111.414 1.414L9.414 10l3.293 3.293a1 1 0 010 1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                void saveTitle();
              }}
              onKeyDown={handleTitleKeyDown}
              className="text-base font-semibold text-slate-900 bg-transparent border-b border-indigo-400 focus:outline-none w-full"
            />
          ) : (
            <button
              type="button"
              onClick={startEditTitle}
              className="text-base font-semibold text-slate-900 hover:text-indigo-700 truncate text-left max-w-xs transition-colors"
              title="Click to rename"
            >
              {dashboard.title}
            </button>
          )}

          {dashboard.description && (
            <p className="text-xs text-slate-500 truncate">{dashboard.description}</p>
          )}
        </div>

        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
            dashboard.status === 'generating'
              ? 'bg-amber-100 text-amber-700'
              : dashboard.status === 'ready'
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-red-100 text-red-600'
          }`}
        >
          {dashboard.status}
        </span>

        <select
          value={refreshInterval ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : Number.parseInt(e.target.value, 10);
            void applyRefreshInterval(v);
          }}
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-300 shrink-0"
          title="Auto-refresh interval"
        >
          {REFRESH_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.value ?? ''}>
              {opt.label === 'Off' ? 'No refresh' : `Refresh ${opt.label}`}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors shrink-0 ${
            editMode
              ? 'bg-indigo-600 text-white hover:bg-indigo-700'
              : 'border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          {editMode ? 'Done Editing' : 'Edit'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {dashboard.status === 'generating' && <GeneratingBanner />}

        {editMode && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                void handleAddPanel();
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z"
                  clipRule="evenodd"
                />
              </svg>
              Add Panel
            </button>
          </div>
        )}

        <DashboardGrid
          panels={dashboard.panels}
          editMode={editMode}
          onEditPanel={(panelId) => {
            const p = dashboard.panels.find((x) => x.id === panelId);
            if (p) setEditingPanel(p);
          }}
          onDeletePanel={(panelId) => {
            void handleDeletePanel(panelId);
          }}
          onLayoutChange={handleLayoutChange}
        />

        {editingPanel && (
          <PanelEditor
            panel={editingPanel}
            onSave={(updated) => {
              void handleSavePanel(updated);
            }}
            onCancel={() => setEditingPanel(null)}
          />
        )}
      </div>
    </div>
  );
}
