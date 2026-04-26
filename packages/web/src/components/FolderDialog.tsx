import React from 'react';
import ReactDOM from 'react-dom';
import { apiClient } from '../api/client.js';
import { DashboardSchema } from '../api/schemas.js';
import { PermissionsDialog } from './permissions/index.js';

interface Dashboard {
  id: string;
  title: string;
  description?: string;
  prompt: string;
  status: 'generating' | 'ready' | 'error';
  type?: string;
  panels: unknown[];
  variables?: unknown[];
  createdAt: string;
  updatedAt?: string;
  folder?: string;
}

export default function FolderDialog({ dashboardId, currentFolder, onSaved, open, onClose }: {
  dashboardId: string; currentFolder?: string; onSaved: (folder: string) => void; open: boolean; onClose: () => void;
}) {
  const [folders, setFolders] = React.useState<Array<{ id: string; name: string; parentId?: string }>>([]);
  const [selected, setSelected] = React.useState(currentFolder || '');
  const [creatingNew, setCreatingNew] = React.useState(false);
  const [newFolder, setNewFolder] = React.useState('');
  const [showPermissions, setShowPermissions] = React.useState<{ id: string; name: string } | null>(null);
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
    const res = await apiClient.putValidated<Dashboard>(`/dashboards/${dashboardId}`, { folder: selected || undefined }, DashboardSchema, 'Dashboard');
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
            <div key={f.id} className="flex items-center gap-1">
              <button type="button" onClick={() => setSelected(f.id)}
                className={`flex-1 flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-left transition-colors ${selected === f.id ? 'bg-primary/10 text-primary' : 'text-on-surface hover:bg-surface-bright'}`}
                style={{ paddingLeft: f.parentId ? 36 : undefined }}>
                <svg className="w-5 h-5 shrink-0 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                <span className="flex-1 truncate">{f.name}</span>
                {selected === f.id && <svg className="w-4 h-4 ml-auto" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowPermissions({ id: f.id, name: f.name }); }}
                title="Folder permissions"
                className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors"
              >
                {/* Shield icon */}
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3z" />
                </svg>
              </button>
            </div>
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

        {showPermissions && (
          <PermissionsDialog
            resource="folders"
            uid={showPermissions.id}
            resourceName={showPermissions.name}
            onClose={() => setShowPermissions(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
