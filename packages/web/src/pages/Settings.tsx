import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { datasourceUrlPlaceholder, llmBaseUrlPlaceholder } from '../constants/placeholders.js';
import { DATASOURCE_TYPES, datasourceInfo } from '../constants/datasource-types.js';
import { LLM_PROVIDERS } from './setup/types.js';
import type { LlmProvider, LlmConfig } from './setup/types.js';
import type { DatasourceType, InstanceDatasource } from '@agentic-obs/common';
import { useAuth } from '../contexts/AuthContext.js';

// ─── Shared types ───
//
// `LlmProvider` / `LlmConfig` (form state) come from `./setup/types.ts`.
// `DatasourceType` / `InstanceDatasource` (wire shape for /api/datasources)
// come from `@agentic-obs/common`. The setup wizard and this page now
// share one definition for each — see T3.1–T3.3.

interface ModelInfo { id: string; name: string; provider: string; description?: string; }

type AuthType = 'none' | 'basic' | 'bearer';
type EnvType = 'prod' | 'staging' | 'dev' | 'test' | 'custom';

/**
 * Form-state for the datasource edit panel. Drops `id` (set by the
 * server) and the audit fields (`createdAt`, `updatedAt`, `updatedBy`)
 * that are read-only from the client's perspective. Adds a synthetic
 * `authType` that drives which credential fields the form renders.
 */
interface DsFormState {
  type: DatasourceType;
  name: string;
  url: string;
  environment?: string;
  cluster?: string;
  label?: string;
  isDefault?: boolean;
  apiKey?: string;
  username?: string;
  password?: string;
  authType: AuthType;
}

interface TestResult { ok: boolean; message: string; version?: string; }

type SettingsTab = 'datasources' | 'llm' | 'notifications' | 'danger';

// ─── Constants ───

const ENV_OPTIONS: EnvType[] = ['prod', 'staging', 'dev', 'test', 'custom'];

const ENV_STYLES: Record<string, string> = {
  prod: 'bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/20',
  staging: 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/20',
  dev: 'bg-[#22C55E]/10 text-[#22C55E] border-[#22C55E]/20',
  test: 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/20',
  custom: 'bg-[var(--color-on-surface-variant)]/10 text-[var(--color-on-surface-variant)] border-[var(--color-on-surface-variant)]/20',
};

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'datasources', label: 'Data Sources',
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" /><path d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" /></svg>,
  },
  {
    id: 'llm', label: 'LLM Provider',
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 00.659 1.591L19 14.5M14.25 3.104c.251.023.501.05.75.082M19 14.5l-2.47-2.47" /><circle cx="12" cy="18" r="3" /></svg>,
  },
  {
    id: 'notifications', label: 'Notifications',
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" /></svg>,
  },
  {
    id: 'danger', label: 'Reset',
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>,
  },
];

// ─── Shared UI ───

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] text-[var(--color-on-surface)] text-sm placeholder-[var(--color-outline)] focus:outline-none focus:border-[var(--color-primary)] transition-colors';
const selectCls = inputCls;
const btnPrimary = 'px-4 py-2 rounded-lg bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)] text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity';
const btnSecondary = 'px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] text-sm font-medium text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-[var(--color-outline)]">{hint}</p>}
    </div>
  );
}

function TypeIcon({ type, size = 'sm' }: { type: DatasourceType; size?: 'sm' | 'md' }) {
  const info = datasourceInfo(type);
  const cls = size === 'md'
    ? 'w-8 h-8 rounded-lg text-[11px] font-bold flex items-center justify-center shrink-0'
    : 'w-6 h-6 rounded text-[9px] font-bold flex items-center justify-center shrink-0';
  return <span className={cls} style={{ backgroundColor: `${info.color}20`, color: info.color }}>{info.icon}</span>;
}

function emptyForm(): DsFormState {
  return { type: 'prometheus', name: '', url: '', environment: 'prod', cluster: '', label: '', isDefault: false, apiKey: '', username: '', password: '', authType: 'none' };
}

// ─── Data Sources Tab ───

function DatasourceForm({ value, onChange, onSave, onCancel, onDelete, saving, isNew, readOnly = false }: {
  value: DsFormState; onChange: (v: DsFormState) => void;
  onSave: () => void; onCancel: () => void; onDelete?: () => void; saving: boolean; isNew: boolean;
  /** When true the form is view-only: no Save, no Delete; Test Connection still works. */
  readOnly?: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const set = (patch: Partial<DsFormState>) => { setTestResult(null); onChange({ ...value, ...patch }); };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const body: Record<string, unknown> = { url: value.url, type: value.type };
    if (value.authType === 'bearer' && value.apiKey) body.apiKey = value.apiKey;
    if (value.authType === 'basic') { body.username = value.username; body.password = value.password; }
    const res = await apiClient.post<TestResult>('/datasources/test', body);
    setTesting(false);
    setTestResult(res.error ? { ok: false, message: res.error.message ?? 'Connection failed' } : res.data);
  };

  return (
    <div className="space-y-3 p-4 bg-[var(--color-surface-highest)] rounded-xl border border-[var(--color-outline-variant)]">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Type">
          <select value={value.type} onChange={(e) => set({ type: e.target.value as DatasourceType })} className={selectCls}>
            {DATASOURCE_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </Field>
        <Field label="Name">
          <input type="text" value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Prometheus" className={inputCls} />
        </Field>
        <Field label="URL" hint="e.g. http://prometheus:9090">
          <input type="url" value={value.url} onChange={(e) => set({ url: e.target.value })} placeholder={datasourceUrlPlaceholder(value.type)} className={inputCls} />
        </Field>
        <Field label="Environment">
          <select value={value.environment ?? 'prod'} onChange={(e) => set({ environment: e.target.value as EnvType })} className={selectCls}>
            {ENV_OPTIONS.map((env) => <option key={env} value={env}>{env}</option>)}
          </select>
        </Field>
        <Field label="Cluster" hint="Optional">
          <input type="text" value={value.cluster ?? ''} onChange={(e) => set({ cluster: e.target.value })} placeholder="us-east-1" className={inputCls} />
        </Field>
        <Field label="Authentication">
          <select value={value.authType} onChange={(e) => set({ authType: e.target.value as AuthType })} className={selectCls}>
            <option value="none">No Authentication</option>
            <option value="bearer">Bearer Token / API Key</option>
            <option value="basic">Basic Auth</option>
          </select>
        </Field>
      </div>

      {value.authType === 'bearer' && (
        <Field label="API Key / Token">
          <input type="password" value={value.apiKey ?? ''} onChange={(e) => set({ apiKey: e.target.value })} placeholder="Bearer token" className={inputCls} />
        </Field>
      )}
      {value.authType === 'basic' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username"><input type="text" value={value.username ?? ''} onChange={(e) => set({ username: e.target.value })} className={inputCls} /></Field>
          <Field label="Password"><input type="password" value={value.password ?? ''} onChange={(e) => set({ password: e.target.value })} className={inputCls} /></Field>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1 flex-wrap">
        <button type="button" onClick={() => void handleTest()} disabled={testing || !value.url} className={btnSecondary}>
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        {testResult && (
          <span className={`text-xs font-medium ${testResult.ok ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
            {testResult.ok ? 'Connected' : testResult.message}
            {testResult.ok && testResult.version && <span className="text-[var(--color-on-surface-variant)] ml-1">({testResult.version})</span>}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
        <label className="flex items-center gap-2 text-xs text-[var(--color-on-surface-variant)] cursor-pointer select-none">
          <input type="checkbox" checked={value.isDefault ?? false} onChange={(e) => set({ isDefault: e.target.checked })} disabled={readOnly} className="w-3.5 h-3.5 rounded accent-[var(--color-primary)] disabled:opacity-50" />
          Set as default
        </label>
        <div className="flex-1" />
        {!readOnly && onDelete && (
          <button type="button" onClick={onDelete} className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-outline)] hover:text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors">Delete</button>
        )}
        <button type="button" onClick={onCancel} className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] transition-colors">
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" onClick={onSave} disabled={saving || !value.name || !value.url} className={btnPrimary + ' !py-1.5 !px-3 !text-xs'}>
            {saving ? 'Saving...' : isNew ? 'Add' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}

function DataSourcesTab({ canCreate, canWrite, canDelete }: { canCreate: boolean; canWrite: boolean; canDelete: boolean }) {
  const [datasources, setDatasources] = useState<InstanceDatasource[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editForms, setEditForms] = useState<Map<string, DsFormState>>(new Map());

  const loadDatasources = useCallback(async () => {
    const res = await apiClient.get<{ datasources: InstanceDatasource[] }>('/datasources');
    if (!res.error) setDatasources(res.data.datasources ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void loadDatasources(); }, [loadDatasources]);

  const toggleExpand = useCallback((id: string, ds: InstanceDatasource) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else {
        next.add(id);
        setEditForms((m) => {
          const n = new Map(m);
          n.set(id, {
            type: ds.type, name: ds.name, url: ds.url, environment: ds.environment ?? 'prod',
            cluster: ds.cluster ?? '', label: ds.label ?? '', isDefault: ds.isDefault ?? false,
            apiKey: ds.apiKey ?? '', username: ds.username ?? '', password: ds.password ?? '',
            authType: ds.apiKey ? 'bearer' : ds.username ? 'basic' : 'none',
          });
          return n;
        });
      }
      return next;
    });
  }, []);

  const handleAdd = useCallback(async (form: DsFormState) => {
    const body: Partial<InstanceDatasource> = {
      type: form.type, name: form.name, url: form.url, environment: form.environment,
      cluster: form.cluster || undefined, label: form.label || undefined, isDefault: form.isDefault,
    };
    if (form.authType === 'bearer' && form.apiKey) body.apiKey = form.apiKey;
    if (form.authType === 'basic') { body.username = form.username; body.password = form.password; }
    const res = await apiClient.post<{ datasource: InstanceDatasource }>('/datasources', body);
    if (!res.error) { setDatasources((prev) => [...prev, res.data.datasource]); setShowAddForm(false); }
  }, []);

  const handleUpdate = useCallback(async (id: string, form: DsFormState) => {
    const body: Partial<InstanceDatasource> = {
      type: form.type, name: form.name, url: form.url, environment: form.environment,
      cluster: form.cluster || undefined, label: form.label || undefined, isDefault: form.isDefault,
    };
    if (form.authType === 'bearer' && form.apiKey) body.apiKey = form.apiKey;
    if (form.authType === 'basic') { body.username = form.username; body.password = form.password; }
    const res = await apiClient.put<{ datasource: InstanceDatasource }>(`/datasources/${id}`, body);
    if (!res.error) {
      setDatasources((prev) => prev.map((d) => (d.id === id ? res.data.datasource : d)));
      setExpandedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/datasources/${id}`);
    if (!res.error) setDatasources((prev) => prev.filter((d) => d.id !== id));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <span className="inline-block w-6 h-6 border-2 border-[var(--color-outline-variant)] border-t-[var(--color-primary)] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-on-surface-variant)]">
          {datasources.length} data source{datasources.length === 1 ? '' : 's'} configured
        </p>
        {!showAddForm && canCreate && (
          <button type="button" onClick={() => setShowAddForm(true)} className={btnPrimary}>
            + Add data source
          </button>
        )}
      </div>

      {showAddForm && canCreate && <AddFormWrapper onSave={handleAdd} onCancel={() => setShowAddForm(false)} />}

      {datasources.length === 0 && !showAddForm && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="w-12 h-12 rounded-xl bg-[var(--color-surface-high)] flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-[var(--color-outline)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" /><path d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-on-surface-variant)] mb-1">No data sources yet</p>
          <p className="text-xs text-[var(--color-outline)] mb-4">Add Prometheus, Loki, or another source to get started</p>
          {canCreate && (
            <button type="button" onClick={() => setShowAddForm(true)} className={btnPrimary}>Add data source</button>
          )}
        </div>
      )}

      {datasources.map((ds) => {
        const info = datasourceInfo(ds.type);
        const isOpen = expandedIds.has(ds.id);
        return (
          <div key={ds.id} className={`rounded-xl border transition-colors ${isOpen ? 'border-[var(--color-primary)]/40 bg-[var(--color-surface-high)]/30' : 'border-[var(--color-outline-variant)] hover:border-[var(--color-outline)]'}`}>
            <button type="button" onClick={() => toggleExpand(ds.id, ds)} className="w-full text-left px-4 py-3 flex items-center gap-3">
              <svg className={`w-3.5 h-3.5 text-[var(--color-outline)] transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <TypeIcon type={ds.type} />
              <span className="text-sm font-medium text-[var(--color-on-surface)] truncate">{ds.name}</span>
              {ds.isDefault && <span className="px-1.5 py-0.5 rounded bg-[var(--color-primary)]/15 text-[var(--color-primary)] text-[10px] font-semibold shrink-0">Default</span>}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0" style={{ backgroundColor: `${info.color}15`, color: info.color, borderColor: `${info.color}30` }}>{info.label}</span>
              {ds.environment && <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${ENV_STYLES[ds.environment] ?? ENV_STYLES.custom}`}>{ds.environment}</span>}
              <span className="flex-1" />
              <span className="text-[11px] text-[var(--color-outline)] font-mono truncate max-w-[200px] hidden sm:inline">{ds.url}</span>
            </button>
            {isOpen && editForms.has(ds.id) && (
              <div className="px-4 pb-4">
                <EditFormWrapper
                  initial={editForms.get(ds.id)!}
                  onSave={(form) => handleUpdate(ds.id, form)}
                  onCancel={() => toggleExpand(ds.id, ds)}
                  onDelete={canDelete ? () => setDeletingId(ds.id) : undefined}
                  readOnly={!canWrite}
                />
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={deletingId !== null}
        title="Delete data source"
        message="This data source will be permanently removed. Panels referencing it may stop working."
        onConfirm={() => { if (deletingId) void handleDelete(deletingId); setDeletingId(null); }}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  );
}

function AddFormWrapper({ onSave, onCancel }: { onSave: (f: DsFormState) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<DsFormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const handleSave = async () => { setSaving(true); await onSave(form); setSaving(false); };
  return <DatasourceForm value={form} onChange={setForm} onSave={() => void handleSave()} onCancel={onCancel} saving={saving} isNew />;
}

function EditFormWrapper({ initial, onSave, onCancel, onDelete, readOnly = false }: {
  initial: DsFormState; onSave: (f: DsFormState) => Promise<void>; onCancel: () => void; onDelete?: () => void; readOnly?: boolean;
}) {
  const [form, setForm] = useState<DsFormState>(initial);
  const [saving, setSaving] = useState(false);
  const handleSave = async () => { setSaving(true); await onSave(form); setSaving(false); };
  return <DatasourceForm value={form} onChange={setForm} onSave={() => void handleSave()} onCancel={onCancel} onDelete={onDelete} saving={saving} isNew={false} readOnly={readOnly} />;
}

// ─── LLM Tab ───

function LlmTab({ canWrite }: { canWrite: boolean }) {
  const [config, setConfig] = useState<LlmConfig>({ provider: 'anthropic', apiKey: '', model: 'claude-sonnet-4-5', baseUrl: '', region: '', authType: 'api-key' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);

  useEffect(() => {
    void apiClient.get<{ llm?: LlmConfig }>('/setup/config').then((res) => {
      if (!res.error && res.data?.llm) {
        setConfig((prev) => ({
          ...prev,
          provider: (res.data.llm!.provider as LlmProvider) ?? prev.provider,
          model: res.data.llm!.model ?? prev.model,
          baseUrl: res.data.llm!.baseUrl ?? '',
          region: res.data.llm!.region ?? '',
          authType: res.data.llm!.authType ?? prev.authType,
        }));
      }
    });
  }, []);

  const provider = LLM_PROVIDERS.find((p) => p.value === config.provider) ?? LLM_PROVIDERS[0]!;
  const availableModels = remoteModels.length > 0
    ? remoteModels.map((m) => ({ id: m.id, label: m.description ? `${m.name} (${m.description})` : m.name }))
    : provider.fallbackModels.map((m) => ({ id: m, label: m }));

  const handleFetchModels = async () => {
    setFetchingModels(true); setRemoteModels([]); setModelsFetched(false);
    const res = await apiClient.post<{ models: ModelInfo[] }>('/setup/llm/models', { provider: config.provider, apiKey: config.apiKey || undefined, baseUrl: config.baseUrl || undefined });
    setFetchingModels(false); setModelsFetched(true);
    if (res.data?.models?.length) {
      setRemoteModels(res.data.models);
      if (!res.data.models.map((m) => m.id).includes(config.model)) setConfig((prev) => ({ ...prev, model: res.data!.models[0]!.id }));
    }
  };

  const handleSave = async () => {
    setSaving(true); setSaved(false);
    // PUT /api/system/llm replaces the legacy POST /setup/llm save path.
    await apiClient.put('/system/llm', {
      provider: config.provider,
      apiKey: config.apiKey || undefined,
      model: config.model,
      baseUrl: config.baseUrl || undefined,
      region: config.region || undefined,
      authType: config.authType || undefined,
    });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/llm/test', {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      region: config.region,
      authType: config.authType,
    });
    setTesting(false);
    setTestResult(res.error ? { ok: false, message: res.error.message } : res.data);
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Provider</label>
        <select value={config.provider} onChange={(e) => {
          const p = e.target.value as LlmProvider;
          const pm = LLM_PROVIDERS.find((x) => x.value === p);
          setConfig((prev) => ({
            ...prev,
            provider: p,
            model: pm?.fallbackModels[0] ?? '',
            apiKey: '',
            baseUrl: '',
            region: '',
            authType: p === 'corporate-gateway' ? 'bearer' : 'api-key',
          }));
          setTestResult(null); setRemoteModels([]); setModelsFetched(false);
        }} className={selectCls}>{LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
      </div>

      {provider.needsKey && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">API Key</label>
          <input type="password" value={config.apiKey} onChange={(e) => { setConfig((prev) => ({ ...prev, apiKey: e.target.value })); setTestResult(null); }} placeholder="sk-..." className={inputCls} />
        </div>
      )}

      {provider.needsUrl && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">{config.provider === 'ollama' ? 'Ollama URL' : 'Endpoint URL'}</label>
          <input type="text" value={config.baseUrl} onChange={(e) => setConfig((prev) => ({ ...prev, baseUrl: e.target.value }))} placeholder={llmBaseUrlPlaceholder(config.provider)} className={inputCls} />
        </div>
      )}

      {provider.needsRegion && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">AWS Region</label>
          <input type="text" value={config.region} onChange={(e) => setConfig((prev) => ({ ...prev, region: e.target.value }))} placeholder="us-east-1" className={inputCls} />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Default Model</label>
        <div className="flex gap-2">
          <select value={config.model} onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))} className={selectCls + ' flex-1'}>
            {availableModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {provider.supportsModelFetch && (
            <button type="button" onClick={() => void handleFetchModels()} disabled={fetchingModels || (provider.needsKey && !config.apiKey)} className={btnSecondary + ' whitespace-nowrap'}>
              {fetchingModels ? 'Loading...' : 'Fetch Models'}
            </button>
          )}
        </div>
        {modelsFetched && remoteModels.length === 0 && <p className="text-xs text-tertiary mt-1">Could not fetch models. Check your API key / URL.</p>}
        {remoteModels.length > 0 && <p className="text-xs text-secondary mt-1">Found {remoteModels.length} models</p>}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t border-[var(--color-outline-variant)]/30">
        <button type="button" onClick={() => void handleTest()} disabled={testing} className={btnSecondary}>{testing ? 'Testing...' : 'Test Connection'}</button>
        {testResult && <span className={`text-sm font-medium ${testResult.ok ? 'text-secondary' : 'text-error'}`}>{testResult.message}</span>}
        <div className="flex-1" />
        {canWrite && (
          <button type="button" onClick={() => void handleSave()} disabled={saving} className={btnPrimary}>
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Notifications Tab ───

function NotificationsTab({ canWrite }: { canWrite: boolean }) {
  const [slackWebhook, setSlackWebhook] = useState('');
  const [pagerDutyKey, setPagerDutyKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true); setSaved(false);
    const notifications: Record<string, unknown> = {};
    if (slackWebhook) notifications['slack'] = { webhookUrl: slackWebhook };
    if (pagerDutyKey) notifications['pagerduty'] = { integrationKey: pagerDutyKey };
    // PUT /api/system/notifications replaces legacy POST /setup/notifications.
    await apiClient.put('/system/notifications', notifications);
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Slack Webhook URL</label>
        <input type="url" value={slackWebhook} onChange={(e) => setSlackWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/..." className={inputCls} />
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">PagerDuty Integration Key</label>
        <input type="password" value={pagerDutyKey} onChange={(e) => setPagerDutyKey(e.target.value)} placeholder="your-integration-key" className={inputCls} />
      </div>
      <div className="flex justify-end pt-2 border-t border-[var(--color-outline-variant)]/30">
        {canWrite && (
          <button type="button" onClick={() => void handleSave()} disabled={saving} className={btnPrimary}>
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Danger Tab ───

function DangerTab({ canReset }: { canReset: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const handleReset = async () => {
    await apiClient.post('/setup/reset', {});
    setDone(true); setConfirming(false);
    window.location.href = '/setup';
  };

  if (!canReset) {
    return (
      <p className="text-sm text-[var(--color-on-surface-variant)]">
        You don't have permission to reset this instance.
      </p>
    );
  }

  return (
    <div>
      <p className="text-sm text-[var(--color-on-surface-variant)] mb-4">
        Reset all configuration and return to the setup wizard. This cannot be undone.
      </p>
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="px-4 py-2 rounded-lg border border-error/50 text-error text-sm font-medium hover:bg-error/10 transition-colors">
          Reset Configuration
        </button>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--color-on-surface)]">Are you sure?</span>
          <button type="button" onClick={() => void handleReset()} disabled={done} className="px-4 py-2 rounded-lg bg-error text-[var(--color-on-primary-fixed)] text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity">Yes, Reset</button>
          <button type="button" onClick={() => setConfirming(false)} className="px-4 py-2 text-sm text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">Cancel</button>
        </div>
      )}
    </div>
  );
}

// ─── Main Settings Page ───

export default function Settings() {
  const [tab, setTab] = useState<SettingsTab>('datasources');
  const { user, hasPermission } = useAuth();
  // Datasources tab: `datasources:create`/`:write`/`:delete` — Admin+ bundle.
  const canCreateDs = !!user && (user.isServerAdmin || hasPermission('datasources:create'));
  const canWriteDs = !!user && (user.isServerAdmin || hasPermission('datasources:write'));
  const canDeleteDs = !!user && (user.isServerAdmin || hasPermission('datasources:delete'));
  // LLM / Notifications / Danger reset: Admin+. There's no canonical `admin:write`
  // action in the catalog yet, so gate by server-admin OR Admin-level bundle
  // (proxied via `datasources:write` — Admin is the only role that has it).
  const canAdminWrite = !!user && (user.isServerAdmin || hasPermission('datasources:write'));

  return (
    <div className="h-full flex">
      {/* Left sidebar tabs */}
      <div className="w-52 shrink-0 border-r border-[var(--color-outline-variant)]/30 py-6 px-3">
        <h1 className="text-lg font-bold text-[var(--color-on-surface)] px-3 mb-5">Settings</h1>
        <nav className="space-y-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                  : 'text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)]/60'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content area */}
      <div className="flex-1 overflow-y-auto py-6 px-8">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-[var(--color-on-surface)] mb-1">
            {TABS.find((t) => t.id === tab)?.label}
          </h2>
          <p className="text-sm text-[var(--color-on-surface-variant)] mb-6">
            {tab === 'datasources' && 'Connect to Prometheus, Loki, Elasticsearch and other data sources.'}
            {tab === 'llm' && 'Configure the AI model used for investigations and analysis.'}
            {tab === 'notifications' && 'Set up alert delivery channels.'}
            {tab === 'danger' && 'Irreversible actions for your OpenObs instance.'}
          </p>

          {tab === 'datasources' && (
            <DataSourcesTab canCreate={canCreateDs} canWrite={canWriteDs} canDelete={canDeleteDs} />
          )}
          {tab === 'llm' && <LlmTab canWrite={canAdminWrite} />}
          {tab === 'notifications' && <NotificationsTab canWrite={canAdminWrite} />}
          {tab === 'danger' && <DangerTab canReset={canAdminWrite} />}
        </div>
      </div>
    </div>
  );
}
