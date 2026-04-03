import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import DashboardCardPreview from '../components/DashboardCardPreview.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
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
  folder?: string;
  starred?: boolean;
}

type ViewMode = 'list' | 'grid';
type SortKey = 'name' | 'date' | 'panels';

// Helpers

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATUS_DOT: Record<Dashboard['status'], string> = {
  generating: 'bg-amber-400 animate-pulse',
  ready: 'bg-emerald-500',
  error: 'bg-red-400',
};

// Folder Tree Row

function FolderRow({
  name,
  dashboards,
  expanded,
  onToggle,
  navigate,
  onDelete,
  onStar,
}: {
  name: string;
  dashboards: Dashboard[];
  expanded: boolean;
  onToggle: () => void;
  navigate: (path: string) => void;
  onDelete: (id: string) => void;
  onStar: (id: string) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-[#141420] transition-colors text-left group"
      >
        <svg
          className={`w-3.5 h-3.5 text-[#555570] transition-transform shrink-0 ${
            expanded ? 'rotate-90' : ''
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <svg
          className="w-4 h-4 text-[#555570] shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M2 6A2 2 0 014 4h4l2 2h6a2 2 0 012 2v1H2V6z" />
          <path d="M2 9h16v5a2 2 0 01-2 2H4a2 2 0 01-2-2V9z" />
        </svg>
        <span className="text-sm font-medium text-[#E8E8ED] flex-1 truncate">{name}</span>
        <span className="text-xs text-[#555570]">{dashboards.length}</span>
      </button>

      {expanded &&
        dashboards.map((dash) => (
          <DashboardListRow
            key={dash.id}
            dash={dash}
            indent
            navigate={navigate}
            onDelete={() => onDelete(dash.id)}
            onStar={() => onStar(dash.id)}
          />
        ))}
    </>
  );
}

// Dashboard List Row

function DashboardListRow({
  dash,
  indent,
  navigate,
  onDelete,
  onStar,
}: {
  dash: Dashboard;
  indent?: boolean;
  navigate: (path: string) => void;
  onDelete: () => void;
  onStar: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 hover:bg-[#141420] transition-colors group ${
        indent ? 'pl-10' : 'px-3'
      }`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[dash.status]}`} />

      <button
        type="button"
        onClick={() => navigate(`/dashboards/${dash.id}`)}
        className="text-sm text-[#E8E8ED] hover:text-[#6366F1] truncate flex-1 text-left transition-colors font-medium"
      >
        {dash.title}
      </button>

      {!indent && dash.folder && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1C1C2E] text-[#555570] shrink-0 hidden sm:inline">
          {dash.folder}
        </span>
      )}

      <span className="text-xs text-[#555570] w-16 text-right shrink-0 hidden md:block">
        {dash.panels.length} {dash.panels.length === 1 ? 'panel' : 'panels'}
      </span>

      <span className="text-xs text-[#555570] w-16 text-right shrink-0 hidden md:block">
        {relativeTime(dash.updatedAt ?? dash.createdAt)}
      </span>

      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onStar}
          className={`p-1 rounded transition-colors ${
            dash.starred ? 'text-[#F59E0B]' : 'text-[#555570] hover:text-[#F59E0B]'
          }`}
          title={dash.starred ? 'Unstar' : 'Star'}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill={dash.starred ? 'currentColor' : 'none'}>
            <path
              stroke="currentColor"
              strokeWidth={1.5}
              d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.371 4.218a1 1 0 00.95.69h4.436c.969 0 1.371 1.24.588 1.81l-3.59 2.61a1 1 0 00-.364 1.118l1.37 4.218c.3.921-.755 1.688-1.54 1.118l-3.59-2.61a1 1 0 00-1.176 0l-3.59 2.61c-.784.57-1.838-.197-1.539-1.118l1.37-4.218a1 1 0 00-.363-1.118l-3.59-2.61c-.784-.57-.38-1.81.588-1.81h4.435a1 1 0 00.951-.69l1.37-4.218z"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded text-[#555570] hover:text-[#EF4444] transition-colors"
          title="Delete"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M8.5 2a1 1 0 00-1 1V4H5a1 1 0 000 2h.293l.853 9.386A2 2 0 008.138 17h3.724a2 2 0 001.992-1.614L14.707 6H15a1 1 0 100-2h-2.5V3a1 1 0 00-1-1h-3zM9.5 4h1V3h-1v1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Dashboard Grid Card

function DashboardGridCard({
  dash,
  navigate,
  onDelete,
}: {
  dash: Dashboard;
  navigate: (path: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative group/card">
      <button
        type="button"
        onClick={() => navigate(`/dashboards/${dash.id}`)}
        className="w-full rounded-xl border border-[#2A2A3E] bg-[#141420] hover:border-[#6366F1]/40 hover:bg-[#1C1C2E] transition-colors p-3 flex flex-col gap-3"
      >
        <DashboardCardPreview
          panels={dash.panels}
          generating={dash.status === 'generating'}
        />

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 text-left">
            <h3 className="text-sm font-semibold text-[#E8E8ED] truncate">{dash.title}</h3>
            <p className="text-xs text-[#555570] mt-0.5">
              {dash.panels.length} panel{dash.panels.length === 1 ? '' : 's'}
              {dash.folder ? <span className="text-[#555570]"> • {dash.folder}</span> : null}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[dash.status]}`} />
            <span className="text-xs text-[#555570]">
              {relativeTime(dash.updatedAt ?? dash.createdAt)}
            </span>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-[#141420]/90 border border-[#2A2A3E] text-[#555570] hover:text-[#EF4444] hover:border-[#EF4444]/40 opacity-0 group-hover/card:opacity-100 transition-all"
        title="Delete"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M8.5 2a1 1 0 00-1 1V4H5a1 1 0 000 2h.293l.853 9.386A2 2 0 008.138 17h3.724a2 2 0 001.992-1.614L14.707 6H15a1 1 0 100-2h-2.5V3a1 1 0 00-1-1h-3zM9.5 4h1V3h-1v1z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}

// Main

export default function Dashboards() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [showStarred, setShowStarred] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [deletingDashId, setDeletingDashId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: / to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadList = useCallback(async () => {
    const res = await apiClient.get<Dashboard[]>('/dashboards');
    if (!res.error) setDashboards(res.data);
    setLoadingList(false);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/dashboards/${id}`);
    if (!res.error) setDashboards((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const handleStar = useCallback(async (id: string) => {
    const dash = dashboards.find((d) => d.id === id);
    if (!dash) return;
    const newStarred = !dash.starred;
    setDashboards((prev) => prev.map((d) => (d.id === id ? { ...d, starred: newStarred } : d)));
    // No backend API for starring yet; purely local state.
  }, [dashboards]);

  const toggleFolder = useCallback((folder: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }, []);

  // Derived data

  const folders = useMemo(() => {
    const set = new Set(dashboards.map((d) => d.folder).filter(Boolean) as string[]);
    return [...set].sort();
  }, [dashboards]);

  const sortFn = useCallback((a: Dashboard, b: Dashboard) => {
    if (sortKey === 'name') return a.title.localeCompare(b.title);
    if (sortKey === 'panels') return b.panels.length - a.panels.length;
    return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
  }, [sortKey]);

  const filtered = useMemo(() => {
    let list = dashboards;
    if (showStarred) list = list.filter((d) => d.starred);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q) ||
          (d.folder ?? '').toLowerCase().includes(q)
      );
    }
    return list.sort(sortFn);
  }, [dashboards, search, showStarred, sortFn]);

  // Group by folder for list view
  const folderGroups = useMemo(() => {
    const groups: Array<{ folder: string; dashboards: Dashboard[] }> = [];
    const folderMap = new Map<string, Dashboard[]>();
    const unfiled: Dashboard[] = [];

    for (const d of filtered) {
      if (d.folder) {
        const arr = folderMap.get(d.folder) ?? [];
        arr.push(d);
        folderMap.set(d.folder, arr);
      } else {
        unfiled.push(d);
      }
    }

    // Sorted folders
    for (const f of [...folderMap.keys()].sort()) {
      groups.push({ folder: f, dashboards: folderMap.get(f)! });
    }

    return { groups, unfiled };
  }, [filtered]);

  return (
    <div className="min-h-full bg-[#0A0A0F]">
      <div className="max-w-5xl mx-auto px-4 py-5 sm:px-6 sm:py-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-[#E8E8ED]">Dashboards</h1>
            <p className="text-xs text-[#555570] mt-0.5">
              Create and manage dashboards to visualize your data.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-3 py-1.5 bg-[#6366F1] text-white text-xs font-medium rounded-lg hover:bg-[#818CF8] transition-colors"
          >
            + New
          </button>
        </div>

        <div className="mb-4">
          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#555570]"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                fill="none"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197M4.7 10a5.3 5.3 0 1010.6 0 5.3 5.3 0 00-10.6 0z"
                />
              </svg>
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search for dashboards or folders"
                className="w-full bg-[#141420] border border-[#2A2A3E] rounded-lg pl-9 pr-9 py-2 text-sm text-[#E8E8ED] placeholder-[#555570] focus:outline-none focus:border-[#6366F1] transition-colors"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8888AA] hover:text-[#E8E8ED]"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              )}
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded bg-[#1C1C2E] text-[10px] text-[#555570] font-mono border border-[#2A2A3E]">
                /
              </kbd>
            </div>

            <label className="flex items-center gap-2 px-3 py-2 bg-[#141420] border border-[#2A2A3E] rounded-lg shrink-0">
              <input
                type="checkbox"
                checked={showStarred}
                onChange={(e) => setShowStarred(e.target.checked)}
                className="sr-only"
              />
              <svg
                className={`w-4 h-4 transition-colors ${showStarred ? 'text-[#F59E0B]' : 'text-[#555570]'}`}
                viewBox="0 0 20 20"
                fill={showStarred ? 'currentColor' : 'none'}
              >
                <path
                  stroke="currentColor"
                  strokeWidth={1.5}
                  d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.371 4.218a1 1 0 00.95.69h4.436c.969 0 1.371 1.24.588 1.81l-3.59 2.61a1 1 0 00-.364 1.118l1.37 4.218c.3.921-.755 1.688-1.54 1.118l-3.59-2.61a1 1 0 00-1.176 0l-3.59 2.61c-.784.57-1.838-.197-1.539-1.118l1.37-4.218a1 1 0 00-.363-1.118l-3.59-2.61c-.784-.57-.38-1.81.588-1.81h4.435a1 1 0 00.951-.69l1.37-4.218z"
                />
              </svg>
              <span className="text-xs text-[#8888AA]">Starred</span>
            </label>

            <div className="flex gap-1 bg-[#141420] rounded-lg border border-[#2A2A3E] p-0.5 shrink-0">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-[#1C1C2E] text-[#E8E8ED]' : 'text-[#555570]'}`}
                title="Grid view"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-[#1C1C2E] text-[#E8E8ED]' : 'text-[#555570]'}`}
                title="Grid view"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
                </svg>
              </button>
            </div>

            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-[#141420] border border-[#2A2A3E] rounded-lg px-3 py-2 text-xs text-[#8888AA] focus:outline-none focus:border-[#6366F1] shrink-0 cursor-pointer"
            >
              <option value="date">Sort by Date</option>
              <option value="name">Sort by Name</option>
              <option value="panels">Sort by Panels</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4 text-xs text-[#555570]">
          <span className="text-[#8888AA] font-medium">{filtered.length} dashboard{filtered.length !== 1 ? 's' : ''}</span>
          <span>•</span>
          <span>{dashboards.length} total</span>
          {folders.length > 0 ? <span>• {folders.length} folder{folders.length !== 1 ? 's' : ''}</span> : null}
        </div>

        {loadingList && (
          <div className="flex justify-center py-16">
            <span className="inline-block w-6 h-6 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
          </div>
        )}

        {!loadingList && dashboards.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[#141420] border border-[#2A2A3E] flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-[#8888AA]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7h18M3 12h18M3 17h12" />
              </svg>
            </div>
            <p className="text-sm text-[#8888AA] mb-1">No dashboards yet</p>
            <p className="text-xs text-[#555570] mb-4">Create one dashboard to monitor and let AI build it</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="px-4 py-2 bg-[#6366F1] text-white text-sm font-medium rounded-lg hover:bg-[#818CF8] transition-colors"
            >
              Create Dashboard
            </button>
          </div>
        )}

        {!loadingList && dashboards.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center py-12 text-center">
            <p className="text-sm text-[#8888AA]">
              No dashboards match <span className="text-[#60A5FA]">"{search}"</span>
            </p>
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setShowStarred(false);
              }}
              className="mt-2 text-xs text-[#818CF8] hover:text-[#6366F1]"
            >
              Clear filters
            </button>
          </div>
        )}

        {!loadingList && filtered.length > 0 && viewMode === 'list' && (
          <div className="rounded-xl border border-[#2A2A3E] overflow-hidden divide-y divide-[#1C1C2E]">
            <div className="flex items-center gap-3 px-3 py-2 bg-[#0A0A0F] text-[11px] font-semibold uppercase tracking-wider text-[#555570]">
              <span className="w-2" />
              <span className="flex-1">Name</span>
              <span className="w-16 text-right hidden md:block">Panels</span>
              <span className="w-16 text-right hidden md:block">Updated</span>
              <span className="w-16" />
            </div>

            {folderGroups.groups.map((group) => (
              <FolderRow
                key={group.folder}
                name={group.folder}
                dashboards={group.dashboards}
                expanded={expandedFolders.has(group.folder)}
                onToggle={() => toggleFolder(group.folder)}
                navigate={navigate}
                onDelete={(id) => setDeletingDashId(id)}
                onStar={(id) => {
                  void handleStar(id);
                }}
              />
            ))}

            {folderGroups.unfiled.map((dash) => (
              <DashboardListRow
                key={dash.id}
                dash={dash}
                navigate={navigate}
                onDelete={() => setDeletingDashId(dash.id)}
                onStar={() => {
                  void handleStar(dash.id);
                }}
              />
            ))}
          </div>
        )}

        {!loadingList && filtered.length > 0 && viewMode === 'grid' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((dash) => (
              <DashboardGridCard
                key={dash.id}
                dash={dash}
                navigate={navigate}
                onDelete={() => setDeletingDashId(dash.id)}
              />
            ))}
          </div>
        )}

        <ConfirmDialog
          open={deletingDashId !== null}
          title="Delete dashboard?"
          message="This dashboard and all its panels will be permanently deleted."
          onConfirm={() => {
            if (deletingDashId) void handleDelete(deletingDashId);
            setDeletingDashId(null);
          }}
          onCancel={() => setDeletingDashId(null)}
        />
      </div>
    </div>
  );
}
