import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import type { PanelConfig } from '../components/DashboardPanelCard.js';
import { relativeTime } from '../utils/time.js';
import { useAuth } from '../contexts/AuthContext.js';

// Types

interface Dashboard {
  id: string;
  title: string;
  description?: string;
  status: 'generating' | 'ready' | 'error';
  type?: string;
  panels: PanelConfig[];
  createdAt: string;
  updatedAt: string;
  folder?: string;
}

interface Folder {
  id: string;
  name: string;
  parentId?: string;
  uid?: string;
  title?: string;
  parentUid?: string | null;
  createdAt: string;
}

type SortKey = 'date' | 'name';

// Helpers

function normalizeFolder(folder: Folder): Folder {
  const id = folder.id ?? folder.uid ?? '';
  const name = folder.name ?? folder.title ?? id;
  const parentId = folder.parentId ?? folder.parentUid ?? undefined;
  return {
    ...folder,
    id,
    name,
    parentId,
  };
}

function StatusBadge({ status }: { status: Dashboard['status'] }) {
  if (status === 'ready') {
    return (
      <span className="text-[10px] bg-secondary/10 text-secondary px-2 py-0.5 rounded uppercase font-bold tracking-tighter">
        Ready
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-[10px] bg-error/10 text-error px-2 py-0.5 rounded uppercase font-bold tracking-tighter">
        Error
      </span>
    );
  }
  return (
    <span className="text-[10px] bg-amber-400/10 text-amber-400 px-2 py-0.5 rounded uppercase font-bold tracking-tighter">
      Generating
    </span>
  );
}

// Page config
const PAGE_CONFIG = {
  title: 'Dashboards',
  subtitle: 'Monitor and visualize your infrastructure metrics.',
  newLabel: '+ New Dashboard',
  emptyTitle: 'No dashboards yet',
  emptyDesc: 'Create a dashboard to start monitoring your infrastructure.',
  navTarget: '/dashboards',
};

// Main

export default function Dashboards() {
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  // Mutating affordances on this page: create dashboard (`dashboards:create`,
  // Editor+), create folder (`folders:create`, Editor+), delete dashboard
  // (`dashboards:delete`, Editor+), delete folder (`folders:delete`, Editor+).
  // Viewer has none of these.
  const canCreateDashboard = !!user
    && (user.isServerAdmin || hasPermission('dashboards:create'));
  const canCreateFolder = !!user
    && (user.isServerAdmin || hasPermission('folders:create'));
  const canDeleteDashboard = !!user
    && (user.isServerAdmin || hasPermission('dashboards:delete'));
  const canDeleteFolder = !!user
    && (user.isServerAdmin || hasPermission('folders:delete'));
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(() => searchParams.get('folder'));
  const config = PAGE_CONFIG;
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');

  // Auto-expand folders from URL query param (e.g., ?expand=id1,id2,id3)
  useEffect(() => {
    setCurrentFolderId(searchParams.get('folder'));
    const expandParam = searchParams.get('expand');
    if (expandParam) {
      const ids = expandParam.split(',').filter(Boolean);
      const lastFolder = ids.at(-1);
      if (lastFolder) setCurrentFolderId(lastFolder);
      // Clean up the URL
      searchParams.delete('expand');
      if (lastFolder) searchParams.set('folder', lastFolder);
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [deletingDashId, setDeletingDashId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showNewFolder) return;
    window.setTimeout(() => {
      newFolderRef.current?.focus();
      newFolderRef.current?.select();
    }, 0);
  }, [showNewFolder]);

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

  const [loadError, setLoadError] = useState<string | null>(null);
  const loadList = useCallback(async () => {
    const loadFolders = async (parentUid?: string): Promise<Folder[]> => {
      const query = parentUid === undefined ? '' : `?parentUid=${encodeURIComponent(parentUid)}`;
      const res = await apiClient.get<Folder[]>(`/folders${query}`);
      if (res.error || !Array.isArray(res.data)) return [];
      const current = res.data.map(normalizeFolder);
      const children = await Promise.all(current.map((folder) => loadFolders(folder.id)));
      return [...current, ...children.flat()];
    };

    const [dashRes, folderItems] = await Promise.all([
      apiClient.get<Dashboard[]>('/dashboards'),
      loadFolders(),
    ]);
    // Treat a missing/non-array body the same as an explicit error — otherwise
    // a 204 / null response would silently set state to a non-array and the
    // UI would render the empty state as if the user had no dashboards.
    if (dashRes.error || !Array.isArray(dashRes.data)) {
      const msg = dashRes.error?.message ?? 'Could not load dashboards';
      setLoadError(msg);
      // Important: do NOT replace existing state on failure — keep showing
      // what the user had before the failed refresh.
    } else {
      setDashboards(dashRes.data);
      setLoadError(null);
    }
    setFolders(folderItems);
    setLoadingList(false);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/dashboards/${id}`);
    if (!res.error) setDashboards((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const cancelNewFolder = useCallback(() => {
    setShowNewFolder(false);
    setNewFolderName('');
  }, []);

  // Sort
  const sortFn = useCallback((a: Dashboard, b: Dashboard) => {
    if (sortKey === 'name') return a.title.localeCompare(b.title);
    return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
  }, [sortKey]);

  const filtered = useMemo(() => dashboards.sort(sortFn), [dashboards, sortFn]);

  // Backend search results
  interface SearchHit { type: string; id: string; title: string; subtitle?: string; matchField?: string; navigateTo: string }
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!search.trim()) { setSearchResults([]); return; }
    setSearching(true);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void apiClient.get<{ results: SearchHit[] }>(`/search?q=${encodeURIComponent(search.trim())}&limit=20`).then((res) => {
        if (!res.error) setSearchResults(res.data.results);
        setSearching(false);
      });
    }, 200);
    return () => clearTimeout(searchTimerRef.current);
  }, [search]);

  const isSearching = search.trim().length > 0;

  // Current directory state
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const folderName = (id: string) => folderMap.get(id)?.name ?? id;
  const openFolder = useCallback((id: string | null) => {
    setCurrentFolderId(id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set('folder', id);
    else next.delete('folder');
    next.delete('expand');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    const res = await apiClient.post<Folder>('/folders', { title: name, parentUid: currentFolderId ?? undefined });
    setCreatingFolder(false);
    if (!res.error) {
      const folder = normalizeFolder(res.data);
      setFolders((prev) => [...prev, folder]);
      setShowNewFolder(false);
      setNewFolderName('');
      openFolder(folder.id);
    }
  }, [creatingFolder, currentFolderId, newFolderName, openFolder]);

  const folderPath = useMemo(() => {
    const path: Folder[] = [];
    const seen = new Set<string>();
    let cursor = currentFolderId ? folderMap.get(currentFolderId) : undefined;
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentId ? folderMap.get(cursor.parentId) : undefined;
    }
    return path;
  }, [currentFolderId, folderMap]);

  const currentFolder = currentFolderId ? folderMap.get(currentFolderId) : null;
  const visibleFolders = useMemo(() => {
    const parentId = currentFolderId ?? undefined;
    return folders
      .filter((folder) => (folder.parentId ?? undefined) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [currentFolderId, folders]);

  const visibleDashboards = useMemo(() => {
    const folderId = currentFolderId ?? undefined;
    return filtered.filter((dashboard) => (dashboard.folder ?? undefined) === folderId);
  }, [currentFolderId, filtered]);

  const nextNewFolderName = useCallback(() => {
    const names = new Set(visibleFolders.map((folder) => folder.name.toLowerCase()));
    if (!names.has('new folder')) return 'New folder';
    let index = 2;
    while (names.has(`new folder ${index}`)) index += 1;
    return `New folder ${index}`;
  }, [visibleFolders]);

  const itemLink = (id: string) => `/dashboards/${id}`;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-lowest">
      <div className="p-8 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-on-surface font-[Manrope]">{config.title}</h1>
            <p className="text-on-surface-variant mt-1 text-sm">{config.subtitle}</p>
          </div>
          <div className="flex gap-2">
            {canCreateFolder && (
              <button
                type="button"
                onClick={() => { setNewFolderName(nextNewFolderName()); setShowNewFolder(true); }}
                className="bg-surface-container border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline px-4 py-2 font-semibold text-sm transition-colors"
              >
                + Folder
              </button>
            )}
            {canCreateDashboard && (
              <button
                type="button"
                onClick={() => navigate('/')}
                className="bg-primary text-on-primary-fixed px-4 py-2 font-semibold text-sm transition-transform active:scale-95"
              >
                {config.newLabel}
              </button>
            )}
          </div>
        </div>

        {/* Search + sort bar */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${config.title.toLowerCase()}...`}
              className="w-full bg-surface-container border border-outline-variant pl-10 pr-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-outline"
            />
          </div>
          <button
            type="button"
            onClick={() => setSortKey(sortKey === 'date' ? 'name' : 'date')}
            className="bg-surface-container border border-outline-variant px-4 py-2.5 text-xs font-medium text-on-surface-variant hover:text-on-surface hover:border-outline transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
            {sortKey === 'date' ? 'Latest' : 'Name'}
          </button>
        </div>

        {/* Loading */}
        {loadingList && (
          <div className="flex justify-center py-16">
            <span className="inline-block w-6 h-6 border-2 border-outline border-t-primary rounded-full animate-spin" />
          </div>
        )}

        {/* Load error — distinct from "no dashboards yet" so the user can
            tell a network failure from a genuinely empty list. */}
        {!loadingList && loadError && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-error mb-2">Failed to load dashboards</p>
            <p className="text-xs text-on-surface-variant mb-4">{loadError}</p>
            <button
              type="button"
              onClick={() => { setLoadingList(true); void loadList(); }}
              className="bg-primary text-on-primary-fixed px-4 py-2 font-semibold text-sm"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state — only when there are no folders either, otherwise the
            folder tree below shows the actual structure and a redundant CTA
            here just clutters the layout (header already has + New Dashboard). */}
        {!loadingList && !loadError && dashboards.length === 0 && folders.length === 0 && !showNewFolder && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 bg-surface-container border border-outline-variant flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </div>
            <p className="text-sm text-on-surface-variant mb-1">{config.emptyTitle}</p>
            <p className="text-xs text-on-surface-variant/60">{config.emptyDesc}</p>
          </div>
        )}

        {/* Search results */}
        {!loadingList && isSearching && (
          <div className="border border-outline-variant bg-surface-container overflow-hidden">
            {searching && (
              <div className="flex justify-center py-8">
                <span className="inline-block w-5 h-5 border-2 border-outline border-t-primary rounded-full animate-spin" />
              </div>
            )}
            {!searching && searchResults.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-on-surface-variant">No results for "<span className="text-primary">{search}</span>"</p>
              </div>
            )}
            {!searching && searchResults.map((r) => (
              <div key={r.id} onClick={() => {
                if (r.type === 'folder') {
                  // Open the folder in-place instead of navigating away.
                  const expandIds = new URL(r.navigateTo, window.location.origin).searchParams.get('expand')?.split(',').filter(Boolean) ?? [];
                  const targetFolder = expandIds.at(-1) ?? r.id;
                  openFolder(targetFolder);
                  setSearch('');
                } else {
                  navigate(r.navigateTo);
                }
              }}
                className="px-5 py-3 flex items-center gap-3 hover:bg-surface-high/45 transition-colors cursor-pointer border-t border-outline-variant first:border-t-0">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                  r.type === 'alert' ? 'bg-error/10 text-error'
                    : r.type === 'folder' ? 'bg-primary/10 text-primary'
                    : r.type === 'panel' ? 'bg-secondary/10 text-secondary'
                    : 'bg-primary/10 text-primary'
                }`}>
                  {r.type === 'folder' ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  ) : r.type === 'alert' ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                  ) : r.type === 'panel' ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10" /></svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z" /></svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-on-surface truncate">{r.title}</div>
                  {r.subtitle && <div className="text-xs text-on-surface-variant truncate mt-0.5">{r.subtitle}</div>}
                </div>
                {r.matchField && (
                  <span className="text-[9px] text-on-surface-variant/50 bg-surface-highest px-1.5 py-0.5 rounded shrink-0">{r.matchField}</span>
                )}
                <span className="text-[9px] text-on-surface-variant/50 bg-surface-highest px-1.5 py-0.5 rounded shrink-0 capitalize">{r.type}</span>
              </div>
            ))}
          </div>
        )}

        {/* Current folder browser (shown when not searching) */}
        {!loadingList && !isSearching && (dashboards.length > 0 || folders.length > 0 || showNewFolder) && (
          <div className="border border-outline-variant bg-surface-container">
            <div className="flex items-center gap-1 border-b border-outline-variant px-3 py-2 text-sm">
              <button
                type="button"
                onClick={() => openFolder(null)}
                className={`px-2 py-1 hover:bg-surface-high transition-colors ${currentFolderId === null ? 'text-on-surface font-medium' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                Dashboards
              </button>
              {folderPath.map((folder) => (
                <React.Fragment key={folder.id}>
                  <span className="text-on-surface-variant/50">/</span>
                  <button
                    type="button"
                    onClick={() => openFolder(folder.id)}
                    className={`min-w-0 px-2 py-1 hover:bg-surface-high transition-colors ${folder.id === currentFolderId ? 'text-on-surface font-medium' : 'text-on-surface-variant hover:text-on-surface'}`}
                  >
                    <span className="block max-w-52 truncate">{folder.name}</span>
                  </button>
                </React.Fragment>
              ))}
            </div>

            {currentFolderId && (
              <button
                type="button"
                onClick={() => openFolder(currentFolder?.parentId ?? null)}
                className="flex w-full items-center gap-3 border-b border-outline-variant px-4 py-2.5 text-left text-sm text-on-surface-variant transition-colors hover:bg-surface-high/45 hover:text-on-surface"
              >
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
                </svg>
                <span>Back to {currentFolder?.parentId ? folderName(currentFolder.parentId) : 'Dashboards'}</span>
              </button>
            )}

            {showNewFolder && (
              <div className="flex items-center gap-3 border-b border-outline-variant bg-surface-high/35 px-4 py-2.5">
                <div className="w-6 h-6 flex items-center justify-center shrink-0 text-on-surface">
                  <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <input
                  ref={newFolderRef}
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void submitNewFolder();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNewFolder();
                    }
                  }}
                  onBlur={() => {
                    if (!newFolderName.trim()) cancelNewFolder();
                  }}
                  placeholder="Folder name"
                  disabled={creatingFolder}
                  className="min-w-0 flex-1 bg-surface-container border border-outline-variant px-2.5 py-1 text-sm text-on-surface outline-none focus:border-outline disabled:opacity-60"
                />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void submitNewFolder()}
                  disabled={!newFolderName.trim() || creatingFolder}
                  className="px-2 py-1 text-xs font-medium text-on-surface disabled:opacity-40"
                >
                  {creatingFolder ? 'Creating...' : 'Create'}
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelNewFolder}
                  className="px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
                >
                  Cancel
                </button>
              </div>
            )}

            {visibleFolders.map((folder) => {
              const childCount = folders.filter((child) => child.parentId === folder.id).length;
              const dashboardCount = dashboards.filter((dashboard) => dashboard.folder === folder.id).length;
              return (
                <div
                  key={folder.id}
                  role="button"
                  tabIndex={0}
                  onDoubleClick={() => openFolder(folder.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') openFolder(folder.id);
                  }}
                  className="group flex items-center gap-3 border-b border-outline-variant px-4 py-2.5 transition-colors hover:bg-surface-high/45 focus:bg-surface-high/45 focus:outline-none"
                  title="Double-click to open"
                >
                  <div className="w-6 h-6 flex items-center justify-center shrink-0 text-on-surface-variant">
                    <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-on-surface">{folder.name}</div>
                    <div className="text-xs text-on-surface-variant">
                      {dashboardCount} dashboards{childCount > 0 ? ` · ${childCount} folders` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openFolder(folder.id)}
                    className="px-2 py-1 text-xs text-on-surface-variant opacity-0 transition-opacity hover:text-on-surface group-hover:opacity-100"
                  >
                    Open
                  </button>
                  {canDeleteFolder && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await apiClient.delete(`/folders/${folder.id}`);
                        setFolders((prev) => prev.filter((f) => f.id !== folder.id));
                      }}
                      className="p-1 text-on-surface-variant hover:text-error hover:bg-error/10"
                      title="Delete folder"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}

            {visibleDashboards.map((dash) => (
              <div
                key={dash.id}
                onClick={() => navigate(itemLink(dash.id))}
                className="flex items-center gap-3 border-b border-outline-variant px-4 py-2.5 transition-colors last:border-b-0 hover:bg-surface-high/45 cursor-pointer group"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-on-surface">{dash.title}</span>
                    <StatusBadge status={dash.status} />
                  </div>
                  <span className="text-xs text-on-surface-variant">{dash.panels.length} panels · {relativeTime(dash.updatedAt ?? dash.createdAt)}</span>
                </div>
                {canDeleteDashboard && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setDeletingDashId(dash.id); }}
                    className="shrink-0 p-1 text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete dashboard"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
            ))}

            {visibleFolders.length === 0 && visibleDashboards.length === 0 && !showNewFolder && (
              <div className="px-4 py-10 text-center text-sm text-on-surface-variant">
                This folder is empty.
              </div>
            )}
          </div>
        )}

        <ConfirmDialog
          open={deletingDashId !== null}
          title="Delete dashboard?"
          message="This will be permanently deleted along with all its panels."
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
