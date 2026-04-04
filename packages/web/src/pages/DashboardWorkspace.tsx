import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import { queryScheduler } from '../api/query-scheduler.js';
import DashboardGrid from '../components/DashboardGrid.js';
import PanelEditor from '../components/PanelEditor.js';
import FloatingToolbar from '../components/FloatingToolbar.js';
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
  panels: PanelConfig[];
  variables?: DashboardVariable[];
  createdAt: string;
  updatedAt?: string;
  folder?: string;
}

// Save to Folder Dropdown

function SaveDropdown({
  dashboardId,
  currentFolder,
  onSaved,
}: {
  dashboardId: string;
  currentFolder?: string;
  onSaved: (folder: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [folders, setFolders] = React.useState<string[]>([]);
  const [newFolder, setNewFolder] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [savedLabel, setSavedLabel] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Load folders from all dashboards when dropdown opens
  React.useEffect(() => {
    if (!open) return;
    void apiClient.get<Dashboard[]>('/dashboards').then((res) => {
      if (!res.error) {
        const set = new Set(res.data.map((d: Dashboard) => d.folder).filter(Boolean) as string[]);
        setFolders([...set].sort());
      }
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const saveToFolder = async (folder: string) => {
    if (!folder.trim()) return;
    setSaving(true);
    const res = await apiClient.put<Dashboard>(`/dashboards/${dashboardId}`, {
      folder: folder.trim(),
    });
    setSaving(false);
    if (!res.error) {
      onSaved(folder.trim());
      setSavedLabel(true);
      setTimeout(() => setSavedLabel(false), 1500);
    }
    setOpen(false);
    setNewFolder('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void saveToFolder(newFolder);
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`p-1.5 rounded-lg transition-colors shrink-0 ${
          savedLabel
            ? 'bg-[#6366F1]/20 text-[#6366F1]'
            : 'hover:bg-[#1C1C2E] text-[#555570] hover:text-[#8888AA]'
        }`}
        title="Save to folder"
        disabled={saving}
      >
        {savedLabel ? (
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M2 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zm2 0v2h12V6H4z" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-52 bg-[#141420] border border-[#2A2A3E] rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="px-3 pt-2.5 pb-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#555570]">
              Save to folder
            </div>
          </div>

          {folders.length > 0 && (
            <div className="px-1">
              {folders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => void saveToFolder(folder)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors text-left ${
                    currentFolder === folder
                      ? 'text-[#6366F1] bg-[#6366F1]/10'
                      : 'text-[#E8E8ED] hover:bg-[#1C1C2E]'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v1H2V6z" />
                    <path d="M2 9h16v5a2 2 0 01-2 2H4a2 2 0 01-2-2V9z" />
                  </svg>
                  <span className="flex-1 truncate">{folder}</span>
                  {currentFolder === folder && (
                    <svg className="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {folders.length > 0 && <div className="border-t border-[#2A2A3E]" />}

          <div className="p-2">
            <input
              ref={inputRef}
              type="text"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="New folder name"
              className="w-full bg-[#1C1C2E] border border-[#2A2A3E] rounded-lg px-2.5 py-1.5 text-xs text-[#E8E8ED] placeholder-[#555570] focus:outline-none focus:border-[#6366F1]"
            />
            <p className="text-[10px] text-[#555570] mt-1 px-0.5">Press Enter to save</p>
          </div>
        </div>
      )}
    </div>
  );
}

// Status badge

function StatusBadge({ status }: { status: Dashboard['status'] }) {
  const dot = {
    generating: 'bg-[#F59E0B] animate-pulse',
    ready: 'bg-[#22C55E]',
    error: 'bg-[#EF4444]',
  };
  const label = { generating: 'Generating', ready: 'Ready', error: 'Error' };

  return (
    <div className="flex items-center gap-1.5 shrink-0" title={label[status]}>
      <span className={`w-2 h-2 rounded-full ${dot[status]}`} />
      <span className="text-xs text-[#555570]">{label[status]}</span>
    </div>
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
  const [editingPanel, setEditingPanel] = useState<PanelConfig | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // Ref to track generation state for use in polling callback (defined before hook)
  const isGeneratingRef = useRef(false);

  // Separate callback for polling that respects generation state
  const pollDashboard = useCallback(async () => {
    if (!id) return;
    const res = await apiClient.get<Dashboard>(`/dashboards/${id}`);
    if (!res.error && res.data) {
      const fresh = res.data;
      if (isGeneratingRef.current) {
        // Only update non-panel fields during generation to avoid fighting SSE
        setDashboard(prev => prev ? { ...prev, title: fresh.title, status: fresh.status } : fresh);
      } else {
        setDashboard(fresh);
      }
    }
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

  // Poll while generating
  useEffect(() => {
    if (dashboard?.status === 'generating') {
      pollRef.current = setInterval(() => {
        void pollDashboard();
      }, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [dashboard?.status, pollDashboard]);

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
  isGeneratingRef.current = isGenerating;
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
            gridCol: item.x,
            gridRow: item.y,
            gridWidth: item.w,
            gridHeight: item.h,
          };
        });

        void apiClient.put<Dashboard>(`/dashboards/${id}/panels`, updatedPanels).then((res) => {
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
      <div className="flex items-center justify-center h-full bg-[#0A0A0F]">
        <span className="inline-block w-6 h-6 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError || !dashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0A0A0F] text-center px-6">
        <p className="text-[#EF4444] text-sm mb-4">{loadError ?? 'Dashboard not found.'}</p>
        <button
          type="button"
          onClick={() => navigate('/dashboards')}
          className="text-sm text-[#6366F1] hover:text-[#818CF8] transition-colors"
        >
          Back to Dashboards
        </button>
      </div>
    );
  }

  // Render

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0A0A0F]">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-[#0A0A0F] border-b border-[#2A2A3E]">
        <button
          type="button"
          onClick={() => navigate(showReport ? '/investigate' : '/dashboards')}
          className="p-1.5 rounded-lg hover:bg-[#1C1C2E] text-[#555570] hover:text-[#8888AA] transition-colors shrink-0"
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
              <span className="inline-block w-2 h-2 rounded-full bg-[#6366F1] animate-pulse shrink-0" />
              <span className="text-sm text-[#8888AA] truncate italic">
                {dashboard.prompt?.length > 50 ? `${dashboard.prompt.slice(0, 50)}...` : dashboard.prompt}
              </span>
            </div>
          ) : showReport ? (
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-4 h-4 text-[#6366F1] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197M4.7 10a5.3 5.3 0 1010.6 0 5.3 5.3 0 00-10.6 0z" />
              </svg>
              <span className="text-sm font-semibold text-[#E8E8ED] truncate">
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
              className="text-sm font-semibold text-[#E8E8ED] bg-transparent border-b border-[#6366F1] focus:outline-none w-full"
            />
          ) : (
            <button
              type="button"
              onClick={startEditTitle}
              className="text-sm font-semibold text-[#E8E8ED] hover:text-[#818CF8] truncate text-left max-w-xs transition-colors"
              title="Click to rename"
            >
              {dashboard.title}
            </button>
          )}

          {!showReport && !isGenerating && dashboard.folder && (
            <span className="text-xs px-2 py-0.5 rounded bg-[#6366F1]/10 text-[#818CF8] border border-[#6366F1]/20 shrink-0">
              {dashboard.folder}
            </span>
          )}
        </div>

        {!isGenerating && dashboard.title !== 'Untitled Dashboard' && (
          <StatusBadge status={dashboard.status} />
        )}

        {!showReport && (
          <>
            <FloatingToolbar
              panels={panels}
              editMode={editMode}
              onToggleEdit={() => setEditMode((v) => !v)}
              onAddPanel={() => {
                void handleAddPanel();
              }}
              onScrollToPanel={scrollToPanel}
            />

            <div className="w-px h-5 bg-[#2A2A3E]" />

            <button
              type="button"
              onClick={() => {
                queryScheduler.clearCache();
                window.dispatchEvent(new CustomEvent('dashboard:refresh-panels'));
              }}
              className="group relative p-2 rounded-lg text-[#555570] hover:text-[#E8E8ED] hover:bg-[#1C1C2E] transition-colors"
              title="Refresh"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m14.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0A8.003 8.003 0 015.163 13M15 15h5" />
              </svg>
            </button>

            {id && (
              <SaveDropdown
                dashboardId={id}
                currentFolder={dashboard.folder}
                onSaved={(folder) => setDashboard((prev) => (prev ? { ...prev, folder } : prev))}
              />
            )}

            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="group relative p-2 rounded-lg text-[#555570] hover:text-[#EF4444] hover:bg-[#1C1C2E] transition-colors shrink-0"
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
            <div className="flex-1 overflow-y-auto overscroll-contain p-4">
              <DashboardGrid
                panels={panels}
                editMode={editMode}
                isGenerating={isGenerating}
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

          <div className="shrink-0 px-4 py-2 border-t border-[#2A2A3E] flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${isGenerating ? 'bg-[#6366F1] animate-pulse' : 'bg-[#22C55E]'}`} />
            <span className="text-xs text-[#555570]">
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

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete dashboard?"
        message="This dashboard and all its panels will be permanently deleted."
        onConfirm={async () => {
          if (id) {
            const res = await apiClient.delete(`/dashboards/${id}`);
            if (!res.error) navigate(showReport ? '/investigate' : '/dashboards');
          }
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
