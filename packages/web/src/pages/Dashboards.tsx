import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import type { PanelConfig } from '../components/DashboardPanelCard.js';
import { relativeTime } from '../utils/time.js';

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
  createdAt: string;
}

type SortKey = 'date' | 'name';

// Helpers

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

// Recursive folder tree node

interface FolderNode { folder: Folder | null; id: string; dashboards: Dashboard[]; children: FolderNode[] }

function FolderTreeNode({ node, depth, expandedFolders, toggleFolder, navigate, itemLink, onDeleteDash, onMoveDash, folders, onCreateSubFolder, creatingInFolder, subFolderName, setSubFolderName, onSubmitSubFolder, onCancelSubFolder, onDeleteFolder }: {
  node: FolderNode; depth: number;
  expandedFolders: Set<string>; toggleFolder: (id: string) => void;
  navigate: (path: string) => void; itemLink: (id: string) => string;
  onDeleteDash: (id: string) => void;
  onMoveDash: (dashId: string, folderId: string) => void;
  folders: Folder[];
  onCreateSubFolder: (parentId: string) => void;
  creatingInFolder: string | null;
  subFolderName: string; setSubFolderName: (v: string) => void;
  onSubmitSubFolder: (parentId: string, name: string) => void;
  onCancelSubFolder: () => void;
  onDeleteFolder: (id: string) => void;
}) {
  const isExpanded = expandedFolders.has(node.id);
  const totalItems = node.dashboards.length + node.children.length;
  const pl = depth * 20;

  return (
    <div className={depth === 0 ? 'bg-surface-high rounded-xl overflow-hidden' : ''}>
      {/* Folder header */}
      <div className="flex items-center group" style={{ paddingLeft: depth > 0 ? pl : undefined }}>
        <button
          type="button"
          onClick={() => toggleFolder(node.id)}
          className={`flex-1 flex items-center gap-2.5 py-2.5 hover:bg-surface-bright/50 transition-colors ${depth === 0 ? 'px-4' : 'px-3'}`}
        >
          <svg className={`w-3.5 h-3.5 text-on-surface-variant transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {node.id === '__none__' ? (
            <span className="text-sm font-semibold text-on-surface">General</span>
          ) : (
            <>
              <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="text-sm font-medium text-on-surface">{node.folder?.name}</span>
            </>
          )}
          <span className="text-[10px] text-on-surface-variant ml-1">{totalItems > 0 ? totalItems : ''}</span>
        </button>
        {/* Folder actions (visible on hover) */}
        <div className="flex items-center gap-0.5 pr-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <button type="button" onClick={() => onCreateSubFolder(node.id)}
            className="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors" title="New sub-folder">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
          {node.id !== '__none__' && (
            <button type="button" onClick={() => onDeleteFolder(node.id)}
              className="p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors" title="Delete folder">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div>
          {/* Sub-folder creation input */}
          {creatingInFolder === node.id && (
            <div className="flex items-center gap-2 px-4 py-2" style={{ paddingLeft: (depth + 1) * 20 + 16 }}>
              <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <input
                autoFocus type="text" value={subFolderName}
                onChange={(e) => setSubFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && subFolderName.trim()) onSubmitSubFolder(node.id, subFolderName.trim());
                  if (e.key === 'Escape') onCancelSubFolder();
                }}
                placeholder="Folder name"
                className="flex-1 bg-surface-highest text-on-surface text-sm rounded-lg px-2.5 py-1 border-none focus:ring-1 focus:ring-primary outline-none"
              />
              <button type="button" onClick={onCancelSubFolder} className="text-xs text-on-surface-variant hover:text-on-surface">Cancel</button>
            </div>
          )}

          {/* Child folders */}
          {node.children.map((child) => (
            <FolderTreeNode key={child.id} node={child} depth={depth + 1}
              expandedFolders={expandedFolders} toggleFolder={toggleFolder}
              navigate={navigate} itemLink={itemLink}
              onDeleteDash={onDeleteDash} onMoveDash={onMoveDash} folders={folders}
              onCreateSubFolder={onCreateSubFolder}
              creatingInFolder={creatingInFolder} subFolderName={subFolderName}
              setSubFolderName={setSubFolderName} onSubmitSubFolder={onSubmitSubFolder}
              onCancelSubFolder={onCancelSubFolder} onDeleteFolder={onDeleteFolder}            />
          ))}

          {/* Dashboards in this folder */}
          {node.dashboards.map((dash) => (
            <div key={dash.id} onClick={() => navigate(itemLink(dash.id))}
              className="flex items-center gap-3 py-2.5 hover:bg-surface-high/40 transition-colors cursor-pointer group border-t border-outline-variant/10"
              style={{ paddingLeft: (depth + 1) * 20 + 16, paddingRight: 16 }}>
              <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-primary/10">
                <svg className="w-3.5 h-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-on-surface truncate">{dash.title}</span>
                  <StatusBadge status={dash.status} />
                </div>
                <span className="text-xs text-on-surface-variant">{dash.panels.length} panels · {relativeTime(dash.updatedAt ?? dash.createdAt)}</span>
              </div>
              <button type="button" onClick={(e) => { e.stopPropagation(); onDeleteDash(dash.id); }}
                className="shrink-0 p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
                title="Delete">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}

          {/* Empty folder message */}
          {node.dashboards.length === 0 && node.children.length === 0 && creatingInFolder !== node.id && (
            <div className="text-xs text-on-surface-variant/50 py-2 italic" style={{ paddingLeft: (depth + 1) * 20 + 16 }}>
              Empty folder
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Main

export default function Dashboards() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const config = PAGE_CONFIG;
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['__none__']));

  // Auto-expand folders from URL query param (e.g., ?expand=id1,id2,id3)
  useEffect(() => {
    const expandParam = searchParams.get('expand');
    if (expandParam) {
      const ids = expandParam.split(',').filter(Boolean);
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      // Clean up the URL
      searchParams.delete('expand');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [deletingDashId, setDeletingDashId] = useState<string | null>(null);
  const [movingDashId, setMovingDashId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingInFolder, setCreatingInFolder] = useState<string | null>(null);
  const [subFolderName, setSubFolderName] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);

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
    const [dashRes, folderRes] = await Promise.all([
      apiClient.get<Dashboard[]>('/dashboards'),
      apiClient.get<Folder[]>('/folders'),
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
    if (!folderRes.error && Array.isArray(folderRes.data)) {
      setFolders(folderRes.data);
    }
    setLoadingList(false);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/dashboards/${id}`);
    if (!res.error) setDashboards((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const handleMoveToFolder = useCallback(async (id: string, folder: string) => {
    const res = await apiClient.put(`/dashboards/${id}`, { folder: folder || undefined });
    if (!res.error) {
      setDashboards((prev) => prev.map((d) => d.id === id ? { ...d, folder: folder || undefined } : d));
      setExpandedFolders((prev) => { const n = new Set(prev); n.add(folder || '__none__'); return n; });
    }
    setMovingDashId(null);
  }, []);


  const toggleFolder = (folder: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

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

  // Build folder tree
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const folderName = (id: string) => folderMap.get(id)?.name ?? id;

  const folderTree = useMemo((): FolderNode[] => {
    // Group dashboards by folder
    const dashByFolder = new Map<string, Dashboard[]>();
    for (const d of filtered) {
      const fid = d.folder || '__none__';
      if (!dashByFolder.has(fid)) dashByFolder.set(fid, []);
      dashByFolder.get(fid)!.push(d);
    }

    // Build tree from flat folder list
    const nodeMap = new Map<string, FolderNode>();
    // Root (General)
    const rootNode: FolderNode = { folder: null, id: '__none__', dashboards: dashByFolder.get('__none__') ?? [], children: [] };
    nodeMap.set('__none__', rootNode);

    // Create nodes for all folders
    for (const f of folders) {
      nodeMap.set(f.id, { folder: f, id: f.id, dashboards: dashByFolder.get(f.id) ?? [], children: [] });
    }

    // Link children to parents
    const roots: FolderNode[] = [rootNode];
    for (const f of folders) {
      const node = nodeMap.get(f.id)!;
      if (f.parentId && nodeMap.has(f.parentId)) {
        nodeMap.get(f.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    // Sort children alphabetically
    const sortNodes = (nodes: FolderNode[]) => {
      nodes.sort((a, b) => {
        if (a.id === '__none__') return -1;
        if (b.id === '__none__') return 1;
        return (a.folder?.name ?? '').localeCompare(b.folder?.name ?? '');
      });
      for (const n of nodes) sortNodes(n.children);
    };
    sortNodes(roots);
    return roots;
  }, [filtered, folders]);

  const itemLink = (id: string) => `/dashboards/${id}`;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-lowest">
      <div className="p-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-on-surface font-[Manrope]">{config.title}</h1>
            <p className="text-on-surface-variant mt-1 text-sm">{config.subtitle}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setShowNewFolder(true); setTimeout(() => newFolderRef.current?.focus(), 50); }}
              className="bg-surface-high text-on-surface-variant hover:text-on-surface px-4 py-2 rounded-lg font-semibold text-sm transition-colors"
            >
              + Folder
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="bg-primary text-on-primary-fixed px-4 py-2 rounded-lg font-semibold text-sm transition-transform active:scale-95"
            >
              {config.newLabel}
            </button>
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
              className="w-full bg-surface-high rounded-lg pl-10 pr-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary border-none"
            />
          </div>
          <button
            type="button"
            onClick={() => setSortKey(sortKey === 'date' ? 'name' : 'date')}
            className="bg-surface-high px-4 py-2.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
            {sortKey === 'date' ? 'Latest' : 'Name'}
          </button>
        </div>

        {/* New folder input */}
        {showNewFolder && (
          <div className="flex items-center gap-2 mb-4 bg-surface-high rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <input
              ref={newFolderRef}
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newFolderName.trim()) {
                  const name = newFolderName.trim();
                  void apiClient.post<Folder>('/folders', { name }).then((res) => {
                    if (!res.error) {
                      setFolders((prev) => [...prev, res.data]);
                      setExpandedFolders((prev) => { const n = new Set(prev); n.add(res.data.id); return n; });
                    }
                  });
                  setShowNewFolder(false);
                  setNewFolderName('');
                }
                if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); }
              }}
              placeholder="Folder name, then Enter"
              className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/60 outline-none"
            />
            <button
              type="button"
              onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}
              className="text-on-surface-variant hover:text-on-surface text-xs"
            >
              Cancel
            </button>
          </div>
        )}

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
              className="bg-primary text-on-primary-fixed px-4 py-2 rounded-lg font-semibold text-sm"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state — only when there are no folders either, otherwise the
            folder tree below shows the actual structure and a redundant CTA
            here just clutters the layout (header already has + New Dashboard). */}
        {!loadingList && !loadError && dashboards.length === 0 && folders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-xl bg-surface-high flex items-center justify-center mb-4">
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
          <div className="bg-surface-high rounded-xl overflow-hidden">
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
                  // Expand the folder path in-place instead of navigating
                  const expandIds = new URL(r.navigateTo, window.location.origin).searchParams.get('expand')?.split(',').filter(Boolean) ?? [];
                  setExpandedFolders((prev) => { const n = new Set(prev); for (const id of expandIds) n.add(id); return n; });
                  setSearch('');
                } else {
                  navigate(r.navigateTo);
                }
              }}
                className="px-5 py-3 flex items-center gap-3 hover:bg-surface-high/40 transition-colors cursor-pointer border-t border-outline-variant/10 first:border-t-0">
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

        {/* Folder tree list (shown when not searching) */}
        {!loadingList && !isSearching && (dashboards.length > 0 || folders.length > 0) && (
          <div className="space-y-1">
            {folderTree.map((node) => (
              <FolderTreeNode key={node.id} node={node} depth={0}
                expandedFolders={expandedFolders} toggleFolder={toggleFolder}
                navigate={navigate} itemLink={itemLink}
                onDeleteDash={setDeletingDashId}
                onMoveDash={(id, folderId) => void handleMoveToFolder(id, folderId)}
                folders={folders}
                onCreateSubFolder={(parentId) => {
                  setCreatingInFolder(parentId);
                  setSubFolderName('');
                  setExpandedFolders((prev) => { const n = new Set(prev); n.add(parentId); return n; });
                }}
                creatingInFolder={creatingInFolder}
                subFolderName={subFolderName}
                setSubFolderName={setSubFolderName}
                onSubmitSubFolder={async (parentId, name) => {
                  const res = await apiClient.post<Folder>('/folders', { name, parentId: parentId === '__none__' ? undefined : parentId });
                  if (!res.error) {
                    setFolders((prev) => [...prev, res.data]);
                    setExpandedFolders((prev) => { const n = new Set(prev); n.add(parentId); n.add(res.data.id); return n; });
                  }
                  setCreatingInFolder(null);
                }}
                onCancelSubFolder={() => setCreatingInFolder(null)}
                onDeleteFolder={async (id) => {
                  await apiClient.delete(`/folders/${id}`);
                  setFolders((prev) => prev.filter((f) => f.id !== id));
                }}
                             />
            ))}
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
