import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import { DashboardSchema } from '../api/schemas.js';
import { queryScheduler } from '../api/query-scheduler.js';
import DashboardGrid from '../components/DashboardGrid.js';
import PanelEditor from '../components/PanelEditor.js';
import VariableBar from '../components/VariableBar.js';
import VariableInferenceBanner from '../components/VariableInferenceBanner.js';
import { useInferredVariables } from '../hooks/useInferredVariables.js';
import InvestigationReportView from '../components/InvestigationReportView.js';
import { useDashboardChat } from '../hooks/useDashboardChat.js';
import { useGlobalChat } from '../contexts/ChatContext.js';
import { useAuth } from '../contexts/AuthContext.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import TimeRangePicker from '../components/TimeRangePicker.js';
import RefreshControl from '../components/RefreshControl.js';
import FolderDialog from '../components/FolderDialog.js';
import ExportMenu from '../components/ExportMenu.js';
import PendingChangesBar from '../components/PendingChangesBar.js';
import type { PendingChangeSummary } from '../components/PendingChangesBar.js';
import { PermissionsDialog } from '../components/permissions/index.js';
import type { PanelConfig } from '../components/DashboardPanelCard.js';
import type { DashboardVariable } from '../hooks/useDashboardChat.js';

// Types

interface PendingChange {
  id: string;
  proposedAt: string;
  proposedBy: string;
  summary: string;
  op: Record<string, unknown>;
}

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
  pendingChanges?: PendingChange[];
}

// Main

export default function DashboardWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const initialPrompt = (location.state as { initialPrompt?: string } | null)
    ?.initialPrompt;
  const initialPromptSent = useRef(false);

  const { user, hasPermission } = useAuth();
  // Every mutating affordance on this page (Edit mode, Add panel, rename,
  // delete, inline panel edit/remove) is gated on dashboards:write. Server
  // admins always pass; the per-dashboard scope matches the backend's
  // check shape (`dashboards:uid:<id>`) so UI hides what the server would
  // 403 anyway.
  const canEditDashboard =
    !!user &&
    (user.isServerAdmin ||
      hasPermission(
        'dashboards:write',
        id ? `dashboards:uid:${id}` : undefined,
      ) ||
      hasPermission('dashboards:write'));
  const canDeleteDashboard =
    !!user &&
    (user.isServerAdmin ||
      hasPermission(
        'dashboards:delete',
        id ? `dashboards:uid:${id}` : undefined,
      ) ||
      hasPermission('dashboards:delete'));
  // Managing per-dashboard ACLs requires `dashboards.permissions:read` (to open
  // the dialog) — Admin-only grant. Hide the button for everyone below.
  const canManagePermissions =
    !!user &&
    (user.isServerAdmin ||
      hasPermission(
        'dashboards.permissions:read',
        id ? `dashboards:uid:${id}` : undefined,
      ) ||
      hasPermission('dashboards.permissions:read'));

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
  // Task 09 — AI-proposed changes for an existing (shared) dashboard. Local
  // state hydrates from the loaded dashboard and from SSE
  // `pending_changes_proposed` events. Accept/discard mutate this list and
  // (on accept) apply the operation to the live panels/variables.
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  // T9 / Wave 6 — wire PermissionsDialog into the dashboard toolbar so
  // operators can manage per-dashboard role/user/team ACLs from the UI.
  const [showPermissionsDialog, setShowPermissionsDialog] = useState(false);

  // pollRef removed — no more polling; SSE pushes all updates
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Load dashboard
  const dashboardLoadedRef = useRef(false);

  const loadDashboard = useCallback(async () => {
    if (!id) return;
    const res = await apiClient.getValidated<Dashboard>(
      `/dashboards/${id}`,
      DashboardSchema,
      'Dashboard',
    );
    const errStatus = Number(
      (res.error as Record<string, unknown> | undefined)?.status,
    );
    const isTransient =
      !!res.error &&
      (res.error.code === 'RATE_LIMITED' ||
        (!Number.isNaN(errStatus) && errStatus >= 500));

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
      setPendingChanges((res.data.pendingChanges as PendingChange[] | undefined) ?? []);
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
    isGenerating: dashboardChatGenerating,
    sendMessage,
    stopGeneration,
    panels,
    variables,
    setPanels,
    setVariables,
    investigationReport,
  } = useDashboardChat(
    id ?? '',
    dashboard?.panels ?? [],
    dashboard?.variables ?? [],
    timeRange,
  );
  const [showReport, setShowReport] = useState(false);
  const globalChat = useGlobalChat();
  const isGenerating = dashboardChatGenerating || globalChat.isGenerating;

  // Tell the global chat which dashboard the user is viewing + current time range
  useEffect(() => {
    if (id) {
      globalChat.setPageContext({ kind: 'dashboard', id, timeRange });
    }
    return () => {
      globalChat.setPageContext(null);
    };
  }, [id, timeRange, globalChat]);

  // Chat history is bound by the URL (`?chat=...`) and loaded in Layout.

  // Investigation reports are now handled in the Investigations page.
  // No auto-show on dashboard — the chat will display a link instead.

  // Auto-send initial prompt from Home page via the global chat
  useEffect(() => {
    if (
      initialPrompt &&
      dashboard &&
      !initialPromptSent.current &&
      !globalChat.isGenerating
    ) {
      initialPromptSent.current = true;
      if (location.state) {
        window.history.replaceState({}, '');
      }
      void globalChat.sendMessage(initialPrompt);
    }
  }, [initialPrompt, dashboard, globalChat]);

  // Task 09 — append SSE-proposed pending changes into local state. Each
  // event id appears once thanks to the hook's monotonic event ids.
  const seenPendingEventRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const evt of events) {
      if (evt.kind !== 'pending_changes_proposed') continue;
      if (seenPendingEventRef.current.has(evt.id)) continue;
      seenPendingEventRef.current.add(evt.id);
      const incoming = (evt.pendingChanges ?? []) as PendingChange[];
      if (incoming.length === 0) continue;
      setPendingChanges((prev) => {
        const seenIds = new Set(prev.map((c) => c.id));
        return [...prev, ...incoming.filter((c) => !seenIds.has(c.id))];
      });
    }
  }, [events]);

  const handleAcceptPending = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const toApply = pendingChanges.filter((c) => ids.includes(c.id));
      // Apply each op locally — same shape as ActionExecutor on the agent side.
      // Acceptance is idempotent: removing a panel that's already gone is a
      // no-op; modifying a non-existent panel id is also a no-op (filter
      // returns the same array). This mirrors action-executor.ts semantics.
      setPanels((prev) => {
        let next = prev;
        for (const c of toApply) {
          const op = c.op as Record<string, unknown>;
          if (op.kind === 'remove_panel') {
            next = next.filter((p) => p.id !== op.panelId);
          } else if (op.kind === 'modify_panel') {
            const patch = op.patch as Partial<PanelConfig>;
            next = next.map((p) =>
              p.id === op.panelId ? { ...p, ...patch } : p,
            );
          }
        }
        return next;
      });
      setVariables((prev) => {
        let next = prev;
        for (const c of toApply) {
          const op = c.op as Record<string, unknown>;
          if (op.kind === 'add_variable') {
            const v = op.variable as DashboardVariable;
            if (!next.find((x) => x.name === v.name)) next = [...next, v];
          }
        }
        return next;
      });
      setPendingChanges((prev) => prev.filter((c) => !ids.includes(c.id)));
    },
    [pendingChanges, setPanels, setVariables],
  );

  const handleDiscardPending = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPendingChanges((prev) => prev.filter((c) => !ids.includes(c.id)));
  }, []);

  const pendingSummaries: PendingChangeSummary[] = React.useMemo(
    () =>
      pendingChanges.map((c) => ({
        id: c.id,
        proposedAt: c.proposedAt,
        proposedBy: c.proposedBy,
        summary: c.summary,
      })),
    [pendingChanges],
  );

  // Reload dashboard once when generation completes (SSE done → isGenerating becomes false)
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating && id) {
      // Generation just finished — fetch final dashboard state once
      void apiClient
        .getValidated<Dashboard>(
          `/dashboards/${id}`,
          DashboardSchema,
          'Dashboard',
        )
        .then((res) => {
          if (!res.error && res.data) {
            setDashboard(res.data);
            setPanels(res.data.panels ?? []);
            setVariables(res.data.variables ?? []);
          }
        });
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating, id, setPanels, setVariables]);

  // Variable changes
  const handleVariableChange = useCallback(
    (name: string, value: string) => {
      setVariables((prev) =>
        prev.map((v) => (v.name === name ? { ...v, current: value } : v)),
      );
      // Datasource swaps invalidate every panel's query cache key, so wipe the
      // shared cache and broadcast a refresh — without this, panels keep
      // showing data from the previous backend until their next interval tick.
      queryScheduler.clearCache();
      window.dispatchEvent(new CustomEvent('dashboard:refresh-panels'));
    },
    [setVariables],
  );

  // Wave 2.4 — variable inference confirm. When the URL carries _inf_<k>=...
  // params we surface a banner; only `state.kind === 'applied'` flows the
  // inferred bindings into panel queries. 'needs-ack' / 'dismissed' do not.
  const inferred = useInferredVariables(id);

  // Resolved variable values for `${name}` substitution in panel queries.
  // Today only `$datasource` flows through here, but the map shape lets us
  // add label/tag substitution later without touching every panel.
  const variableValues = React.useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const v of variables) {
      if (v.current) out[v.name] = v.current;
    }
    if (inferred.state.kind === 'applied') {
      for (const [k, v] of Object.entries(inferred.state.vars)) {
        out[k] = v;
      }
    }
    return out;
  }, [variables, inferred.state]);

  // Title editing

  const startEditTitle = () => {
    setTitleDraft(dashboard?.title ?? '');
    setEditingTitle(true);
  };

  const saveTitle = async () => {
    if (!id || !titleDraft.trim()) return;
    const res = await apiClient.putValidated<Dashboard>(
      `/dashboards/${id}`,
      {
        title: titleDraft.trim(),
      },
      DashboardSchema,
      'Dashboard',
    );
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
    const res = await apiClient.putValidated<Dashboard>(
      `/dashboards/${id}/panels`,
      newPanels,
      DashboardSchema,
      'Dashboard',
    );
    if (!res.error) {
      setDashboard(res.data);
      setPanels(res.data.panels);
    }
    setEditingPanel(null);
  };

  const handleDeletePanel = async (panelId: string) => {
    if (!id) return;
    const res = await apiClient.delete(`/dashboards/${id}/panels/${panelId}`);
    if (!res.error) {
      await loadDashboard();
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
    const res = await apiClient.postValidated<Dashboard>(
      `/dashboards/${id}/panels`,
      newPanel,
      DashboardSchema,
      'Dashboard',
    );
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
    (
      newLayout: Array<{
        i: string;
        x: number;
        y: number;
        w: number;
        h: number;
      }>,
    ) => {
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

        void apiClient
          .putValidated<Dashboard>(
            `/dashboards/${id}/panels`,
            { panels: updatedPanels },
            DashboardSchema,
            'Dashboard',
          )
          .then((res) => {
            if (!res.error) {
              setDashboard(res.data);
              setPanels(res.data.panels);
            }
          });
      }, 500);
    },
    [id, panels, setPanels],
  );

  // Scroll to panel
  const scrollToPanel = useCallback((panelId: string) => {
    const el = document.getElementById(`panel-${panelId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Loading / error states
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-lowest">
        <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError || !dashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-surface-lowest text-center px-6">
        <p className="text-error text-sm mb-4">
          {loadError ?? 'Dashboard not found.'}
        </p>
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
    <div className="flex flex-col h-full overflow-hidden bg-surface-lowest">
      <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 bg-surface-lowest border-b border-outline-variant">
        <button
          type="button"
          onClick={() =>
            navigate(
              dashboard?.type === 'investigation'
                ? '/investigations'
                : '/dashboards',
            )
          }
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
                {dashboard.prompt?.length > 50
                  ? `${dashboard.prompt.slice(0, 50)}...`
                  : dashboard.prompt}
              </span>
            </div>
          ) : showReport ? (
            <div className="flex items-center gap-2 min-w-0">
              <svg
                className="w-4 h-4 text-primary shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197M4.7 10a5.3 5.3 0 1010.6 0 5.3 5.3 0 00-10.6 0z"
                />
              </svg>
              <span className="text-sm font-semibold text-on-surface truncate">
                {dashboard.title.startsWith('Investigation')
                  ? dashboard.title
                  : 'Investigation'}
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
          ) : canEditDashboard ? (
            <button
              type="button"
              onClick={startEditTitle}
              className="text-sm font-semibold text-on-surface hover:text-primary-container truncate text-left max-w-xs transition-colors"
              title="Click to rename"
            >
              {dashboard.title}
            </button>
          ) : (
            // Non-writers: render as plain text — no rename affordance.
            <span className="text-sm font-semibold text-on-surface truncate max-w-xs">
              {dashboard.title}
            </span>
          )}

          {!showReport && !isGenerating && dashboard.folder && (
            <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
              {dashboard.folder}
            </span>
          )}
        </div>

        {/* Center: time range + refresh control (manual + auto) */}
        {!showReport && (
          <div className="flex items-center gap-2 shrink-0">
            <TimeRangePicker
              value={timeRange}
              onChange={(v) => {
                setTimeRange(v);
                queryScheduler.clearCache();
                window.dispatchEvent(new CustomEvent('dashboard:refresh-panels'));
              }}
            />
            <RefreshControl
              onRefresh={() => {
                queryScheduler.clearCache();
                window.dispatchEvent(new CustomEvent('dashboard:refresh-panels'));
              }}
            />
          </div>
        )}

        {!showReport && (
          <>
            {/* Edit toggle — hidden for roles without dashboards:write */}
            {canEditDashboard && (
              <button
                type="button"
                onClick={() => setEditMode((v) => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  editMode
                    ? 'bg-primary text-on-primary-fixed'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-high'
                }`}
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                {editMode ? 'Editing' : 'Edit'}
              </button>
            )}

            {/* Add panel (only in edit mode, and only if the user can write) */}
            {editMode && canEditDashboard && (
              <button
                type="button"
                onClick={() => void handleAddPanel()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 4.5v15m7.5-7.5h-15"
                  />
                </svg>
                Add Panel
              </button>
            )}

            {/* Export */}
            <ExportMenu dashboard={dashboard} />

            {id && canEditDashboard && (
              <button
                type="button"
                onClick={() => setShowFolderDialog(true)}
                className="p-1.5 rounded-lg transition-colors hover:bg-surface-high text-on-surface-variant hover:text-on-surface"
                title={
                  dashboard.folder
                    ? `Folder: ${dashboard.folder}`
                    : 'Move to folder'
                }
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                  />
                </svg>
              </button>
            )}

            {id && canManagePermissions && (
              <button
                type="button"
                onClick={() => setShowPermissionsDialog(true)}
                className="p-1.5 rounded-lg transition-colors hover:bg-surface-high text-on-surface-variant hover:text-on-surface"
                title="Permissions"
              >
                {/* Shield icon */}
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3z"
                  />
                </svg>
              </button>
            )}

            {canDeleteDashboard && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="group relative p-2 rounded-lg text-on-surface-variant hover:text-error hover:bg-surface-high transition-colors shrink-0"
                title="Delete"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16"
                  />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          {inferred.state.kind === 'needs-ack' && (
            <VariableInferenceBanner
              vars={inferred.state.vars}
              onAccept={inferred.accept}
              // "Change variables" just dismisses the banner so the user can
              // pick values manually from the VariableBar below. The picker
              // already exists — we don't re-invent it here.
              onChange={inferred.dismiss}
              onDismiss={inferred.dismiss}
            />
          )}
          <VariableBar
            dashboardId={id ?? ''}
            variables={variables}
            onChange={handleVariableChange}
          />

          {pendingSummaries.length > 0 && (
            <PendingChangesBar
              changes={pendingSummaries}
              onAccept={handleAcceptPending}
              onDiscard={handleDiscardPending}
            />
          )}

          {showReport && investigationReport ? (
            <InvestigationReportView
              report={investigationReport}
              onClose={() => setShowReport(false)}
            />
          ) : (
            <div className="flex-1 overflow-y-auto overscroll-contain p-6 bg-surface-lowest">
              <DashboardGrid
                panels={panels}
                editMode={editMode}
                isGenerating={isGenerating}
                timeRange={timeRange}
                variableValues={variableValues}
                // When the user lacks write permission we pass `undefined`
                // for the per-panel edit/delete callbacks. DashboardPanelCard
                // conditionally renders the pencil/trash buttons on the
                // truthiness of these callbacks (see DashboardPanelCard.tsx
                // lines ~690 and ~715), so this removes them from the DOM
                // entirely — not just hidden-until-hover — for Viewers.
                onEditPanel={
                  canEditDashboard
                    ? (panelId) => {
                        const p = panels.find((x) => x.id === panelId);
                        if (p) setEditingPanel(p);
                      }
                    : undefined
                }
                onDeletePanel={
                  canEditDashboard
                    ? (panelId) => {
                        void handleDeletePanel(panelId);
                      }
                    : undefined
                }
                onLayoutChange={handleLayoutChange}
                onTimeRangeChange={setTimeRange}
              />
            </div>
          )}

          <div className="shrink-0 px-6 py-2 flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isGenerating ? 'bg-primary animate-pulse' : 'bg-secondary'}`}
            />
            <span className="text-xs text-on-surface-variant">
              {isGenerating
                ? 'Generating...'
                : `${panels.length} panel${panels.length !== 1 ? 's' : ''} ready`}
            </span>
          </div>
        </div>
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
          onSaved={(folder) =>
            setDashboard((prev) => (prev ? { ...prev, folder } : prev))
          }
        />
      )}

      {id && showPermissionsDialog && dashboard && (
        <PermissionsDialog
          resource="dashboards"
          uid={id}
          resourceName={dashboard.title}
          onClose={() => setShowPermissionsDialog(false)}
        />
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete dashboard?"
        message="This dashboard and all its panels will be permanently deleted."
        onConfirm={async () => {
          if (id) {
            const res = await apiClient.delete(`/dashboards/${id}`);
            if (!res.error)
              navigate(
                dashboard?.type === 'investigation'
                  ? '/investigations'
                  : '/dashboards',
              );
          }
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
