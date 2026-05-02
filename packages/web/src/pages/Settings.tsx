import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';
import {
  buildOpsConnectorInput,
  inspectKubeconfigMetadata,
  isLocalhostApiServer,
  opsApi,
  type KubeconfigMetadata,
  type OpsCapability,
  type OpsConnector,
  type OpsConnectorMode,
} from '../api/ops-api.js';
import { githubChangeSourcesApi, type GitHubChangeSource } from '../api/github-change-sources-api.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { datasourceUrlPlaceholder, llmBaseUrlPlaceholder } from '../constants/placeholders.js';
import { DATASOURCE_TYPES, datasourceInfo } from '../constants/datasource-types.js';
import { LLM_PROVIDERS } from './setup/types.js';
import type { LlmProvider, LlmConfig } from './setup/types.js';
import type { DatasourceType, InstanceDatasource } from '@agentic-obs/common';
import { useAuth } from '../contexts/AuthContext.js';
import { notifyDatasourcesChanged } from '../hooks/useDatasourceLookup.js';

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

type SettingsTab = 'datasources' | 'github' | 'ops' | 'llm' | 'notifications' | 'danger';

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
    id: 'github', label: 'GitHub',
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h6m-6 4h10M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" /></svg>,
  },
  {
    id: 'ops', label: 'Kubernetes',
    icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M7 7v10a2 2 0 002 2h6a2 2 0 002-2V7M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M9 12h6M9 15h4" /></svg>,
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
    try {
      const body: Record<string, unknown> = { url: value.url, type: value.type };
      if (value.authType === 'bearer' && value.apiKey) body.apiKey = value.apiKey;
      if (value.authType === 'basic') { body.username = value.username; body.password = value.password; }
      const res = await apiClient.post<TestResult>('/datasources/test', body);
      setTestResult(res.error ? { ok: false, message: res.error.message ?? 'Connection failed' } : res.data);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection failed' });
    } finally {
      setTesting(false);
    }
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
  // Per-row in-flight flag for the "set as default" star — disables the
  // button while the PUT is pending so a double-click doesn't fire two
  // mutations against the single-default-per-(org,type) invariant.
  const [defaultUpdatingId, setDefaultUpdatingId] = useState<string | null>(null);

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
    // Auto-default the first datasource of a given type — there's no other
    // sensible default the agent could fall back on, so promoting it here
    // saves the operator a second click. If the user already ticked the box,
    // we keep their explicit choice.
    const isFirstOfType = !datasources.some((d) => d.type === form.type);
    const isDefault = form.isDefault || isFirstOfType;
    const body: Partial<InstanceDatasource> = {
      type: form.type, name: form.name, url: form.url, environment: form.environment,
      cluster: form.cluster || undefined, label: form.label || undefined, isDefault,
    };
    if (form.authType === 'bearer' && form.apiKey) body.apiKey = form.apiKey;
    if (form.authType === 'basic') { body.username = form.username; body.password = form.password; }
    const res = await apiClient.post<{ datasource: InstanceDatasource }>('/datasources', body);
    if (!res.error) {
      const created = res.data.datasource;
      setDatasources((prev) => {
        // Mirror the backend single-default-per-(org,type) invariant locally
        // so the new row's "Default" pill shows up immediately and any sibling
        // of the same type loses its pill without waiting for a refetch.
        const next = created.isDefault
          ? prev.map((d) => (d.type === created.type ? { ...d, isDefault: false } : d))
          : prev;
        return [...next, created];
      });
      setShowAddForm(false);
      notifyDatasourcesChanged();
    }
  }, [datasources]);

  const handleUpdate = useCallback(async (id: string, form: DsFormState) => {
    const body: Partial<InstanceDatasource> = {
      type: form.type, name: form.name, url: form.url, environment: form.environment,
      cluster: form.cluster || undefined, label: form.label || undefined, isDefault: form.isDefault,
    };
    if (form.authType === 'bearer' && form.apiKey) body.apiKey = form.apiKey;
    if (form.authType === 'basic') { body.username = form.username; body.password = form.password; }
    const res = await apiClient.put<{ datasource: InstanceDatasource }>(`/datasources/${id}`, body);
    if (!res.error) {
      const updated = res.data.datasource;
      setDatasources((prev) =>
        prev.map((d) => {
          if (d.id === id) return updated;
          // Demote sibling rows of the same type if this update set isDefault.
          if (updated.isDefault && d.type === updated.type) return { ...d, isDefault: false };
          return d;
        }),
      );
      setExpandedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      notifyDatasourcesChanged();
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/datasources/${id}`);
    if (!res.error) {
      setDatasources((prev) => prev.filter((d) => d.id !== id));
      notifyDatasourcesChanged();
    }
  }, []);

  const handleSetDefault = useCallback(async (ds: InstanceDatasource) => {
    if (ds.isDefault || defaultUpdatingId) return;
    setDefaultUpdatingId(ds.id);
    try {
      const res = await apiClient.put<{ datasource: InstanceDatasource }>(
        `/datasources/${ds.id}`,
        { isDefault: true },
      );
      if (!res.error) {
        const updated = res.data.datasource;
        setDatasources((prev) =>
          prev.map((d) => {
            if (d.id === updated.id) return updated;
            // Mirror the server's single-default-per-(org,type) invariant.
            if (d.type === updated.type) return { ...d, isDefault: false };
            return d;
          }),
        );
        notifyDatasourcesChanged();
      }
    } finally {
      setDefaultUpdatingId(null);
    }
  }, [defaultUpdatingId]);

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
          <p className="text-xs text-[var(--color-outline)]">Add Prometheus, Loki, or another source to get started</p>
        </div>
      )}

      {datasources.map((ds) => {
        const info = datasourceInfo(ds.type);
        const isOpen = expandedIds.has(ds.id);
        const starBusy = defaultUpdatingId === ds.id;
        const starDisabled = !canWrite || starBusy || ds.isDefault;
        const starTitle = ds.isDefault
          ? `Default for ${info.label}`
          : 'Set as default for this type';
        return (
          <div key={ds.id} className={`rounded-xl border transition-colors ${isOpen ? 'border-[var(--color-primary)]/40 bg-[var(--color-surface-high)]/30' : 'border-[var(--color-outline-variant)] hover:border-[var(--color-outline)]'}`}>
            <div className="w-full px-4 py-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggleExpand(ds.id, ds)}
                className="flex-1 min-w-0 text-left flex items-center gap-3"
              >
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
              <button
                type="button"
                onClick={() => void handleSetDefault(ds)}
                disabled={starDisabled}
                title={starTitle}
                aria-label={starTitle}
                aria-pressed={ds.isDefault}
                className={`shrink-0 p-1 rounded transition-colors ${
                  ds.isDefault
                    ? 'text-[var(--color-primary)]'
                    : 'text-[var(--color-on-surface-variant)]/60 hover:text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10'
                } ${starBusy ? 'opacity-50' : ''} ${ds.isDefault ? 'cursor-default' : starDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {ds.isDefault ? (
                  // Filled star
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path d="M10 1.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L10 14.77l-5.2 2.73.99-5.78L1.58 7.62l5.82-.85L10 1.5z" />
                  </svg>
                ) : (
                  // Hollow star
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                    <path strokeLinejoin="round" d="M10 1.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L10 14.77l-5.2 2.73.99-5.78L1.58 7.62l5.82-.85L10 1.5z" />
                  </svg>
                )}
              </button>
            </div>
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

// ─── GitHub Change Sources Tab ───

const GITHUB_EVENTS = [
  { id: 'deployment', label: 'Deployments' },
  { id: 'deployment_status', label: 'Deployment status' },
];

function GitHubChangeSourcesTab({ canWrite }: { canWrite: boolean }) {
  const [sources, setSources] = useState<GitHubChangeSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<GitHubChangeSource | null>(null);
  const [form, setForm] = useState({
    name: '',
    owner: '',
    repo: '',
    secret: '',
    events: { deployment: true, deployment_status: true } as Record<string, boolean>,
  });

  const loadSources = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setSources(await githubChangeSourcesApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GitHub sources');
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSources(); }, [loadSources]);

  const webhookUrl = (path: string) => `${window.location.origin}${path}`;

  const handleCreate = async () => {
    setSaving(true); setError(null); setCreated(null);
    try {
      const source = await githubChangeSourcesApi.create({
        name: form.name.trim(),
        owner: form.owner.trim() || undefined,
        repo: form.repo.trim() || undefined,
        secret: form.secret.trim() || undefined,
        events: GITHUB_EVENTS.filter((event) => form.events[event.id]).map((event) => event.id),
      });
      setSources((prev) => [...prev, source]);
      setCreated(source);
      setShowForm(false);
      setForm({
        name: '',
        owner: '',
        repo: '',
        secret: '',
        events: { deployment: true, deployment_status: true },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create GitHub source');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await githubChangeSourcesApi.delete(id);
      setSources((prev) => prev.filter((source) => source.id !== id));
      if (created?.id === id) setCreated(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete GitHub source');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <span className="inline-block w-6 h-6 border-2 border-[var(--color-outline-variant)] border-t-[var(--color-primary)] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--color-on-surface-variant)]">
            {sources.length > 0 ? `${sources.length} GitHub source${sources.length === 1 ? '' : 's'} connected` : 'No GitHub sources connected'}
          </p>
          <p className="text-xs text-[var(--color-outline)] mt-0.5">
            Deployment webhooks become change events the agent can correlate during investigations.
          </p>
        </div>
        {!showForm && canWrite && (
          <button type="button" onClick={() => setShowForm(true)} className={btnPrimary}>
            Connect GitHub
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-[#EF4444]/25 bg-[#EF4444]/10 px-3 py-2 text-sm text-[#EF4444]">
          {error}
        </div>
      )}

      {created && (
        <div className="rounded-lg border border-[#22C55E]/20 bg-[#22C55E]/10 px-3 py-3">
          <p className="text-sm font-medium text-[#22C55E]">GitHub source created</p>
          <div className="mt-2 grid gap-2 text-xs">
            <div>
              <span className="text-[var(--color-outline)]">Webhook URL</span>
              <div className="mt-1 font-mono text-[var(--color-on-surface)] break-all">{webhookUrl(created.webhookPath)}</div>
            </div>
            {created.secret && (
              <div>
                <span className="text-[var(--color-outline)]">Webhook secret</span>
                <div className="mt-1 font-mono text-[var(--color-on-surface)] break-all">{created.secret}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {showForm && canWrite && (
        <div className="space-y-4 p-4 bg-[var(--color-surface-highest)] rounded-xl border border-[var(--color-outline-variant)]">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-on-surface)]">Connect GitHub deployments</h3>
            <p className="text-xs text-[var(--color-on-surface-variant)] mt-0.5">
              Create a webhook endpoint, then paste the URL and secret into a GitHub repository webhook.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input type="text" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="Prod deploys" className={inputCls} />
            </Field>
            <Field label="Owner" hint="Optional">
              <input type="text" value={form.owner} onChange={(e) => setForm((prev) => ({ ...prev, owner: e.target.value }))} placeholder="openobs" className={inputCls} />
            </Field>
            <Field label="Repository" hint="Optional">
              <input type="text" value={form.repo} onChange={(e) => setForm((prev) => ({ ...prev, repo: e.target.value }))} placeholder="openobs" className={inputCls} />
            </Field>
            <Field label="Webhook secret" hint="Leave blank to generate one.">
              <input type="password" value={form.secret} onChange={(e) => setForm((prev) => ({ ...prev, secret: e.target.value }))} placeholder="Generated if blank" className={inputCls} />
            </Field>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-2">Events</label>
            <div className="flex flex-wrap gap-3">
              {GITHUB_EVENTS.map((event) => (
                <label key={event.id} className="flex items-center gap-2 text-sm text-[var(--color-on-surface-variant)]">
                  <input
                    type="checkbox"
                    checked={form.events[event.id]}
                    onChange={(e) => setForm((prev) => ({ ...prev, events: { ...prev.events, [event.id]: e.target.checked } }))}
                    className="w-3.5 h-3.5 rounded accent-[var(--color-primary)]"
                  />
                  {event.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
            <button type="button" onClick={() => setShowForm(false)} className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] transition-colors">Cancel</button>
            <button type="button" onClick={() => void handleCreate()} disabled={saving || !form.name.trim()} className={btnPrimary + ' !py-1.5 !px-3 !text-xs'}>
              {saving ? 'Connecting...' : 'Create webhook'}
            </button>
          </div>
        </div>
      )}

      {sources.map((source) => (
        <div key={source.id} className="rounded-xl border border-[var(--color-outline-variant)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-on-surface)]">{source.name}</span>
                <span className="px-1.5 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)] text-[10px] font-medium">changes</span>
                {source.lastEventAt && <span className="text-[10px] text-[var(--color-outline)]">last event {new Date(source.lastEventAt).toLocaleString()}</span>}
              </div>
              <p className="mt-1 text-xs text-[var(--color-outline)] font-mono break-all">{webhookUrl(source.webhookPath)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {source.owner && <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-high)] text-[10px] text-[var(--color-on-surface-variant)]">{source.owner}{source.repo ? `/${source.repo}` : ''}</span>}
                {source.events.map((event) => (
                  <span key={event} className="px-1.5 py-0.5 rounded bg-[var(--color-surface-high)] text-[10px] text-[var(--color-on-surface-variant)]">{event}</span>
                ))}
                <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-high)] text-[10px] text-[var(--color-on-surface-variant)]">{source.secretMasked}</span>
              </div>
            </div>
            {canWrite && (
              <button type="button" onClick={() => void handleDelete(source.id)} className="px-3 py-1.5 rounded-lg text-xs text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors">
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Ops Integrations Tab ───

function inspectPastedKubeconfig(yaml: string): KubeconfigMetadata | null {
  if (!yaml.trim()) return null;
  return inspectKubeconfigMetadata(yaml);
}

const OPS_CAPABILITIES: { id: OpsCapability; label: string }[] = [
  { id: 'read', label: 'Run diagnostics' },
  { id: 'propose', label: 'Draft remediation plans' },
  { id: 'execute_approved', label: 'Execute approved changes' },
];

function OpsIntegrationsTab({ canWrite }: { canWrite: boolean }) {
  const [connectors, setConnectors] = useState<OpsConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [inClusterAvailable, setInClusterAvailable] = useState(false);
  const [form, setForm] = useState({
    mode: 'kubeconfig' as OpsConnectorMode,
    name: '',
    environment: 'prod',
    clusterName: '',
    namespaces: '',
    kubeconfig: '',
    context: '',
    apiServer: '',
    token: '',
    caData: '',
    insecureSkipTlsVerify: false,
    capabilities: { read: true, propose: true, execute_approved: false } as Record<OpsCapability, boolean>,
  });

  useEffect(() => {
    void apiClient.get<{ inClusterAvailable: boolean }>('/system/info').then((res) => {
      if (!res.error && res.data?.inClusterAvailable) {
        setInClusterAvailable(true);
        setForm((prev) => ({ ...prev, mode: 'in-cluster' }));
      }
    });
  }, []);

  const loadConnectors = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setConnectors(await opsApi.listConnectors());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Ops connectors');
      setConnectors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadConnectors(); }, [loadConnectors]);

  const updateForm = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));
  const kubeconfigPreview = inspectPastedKubeconfig(form.kubeconfig);

  const updateKubeconfig = (value: string) => {
    const preview = inspectPastedKubeconfig(value);
    updateForm({
      kubeconfig: value,
      ...(preview?.clusterName && !form.clusterName ? { clusterName: preview.clusterName } : {}),
      ...(preview?.context && !form.context ? { context: preview.context } : {}),
      ...(preview?.apiServer ? { apiServer: preview.apiServer } : {}),
    });
  };

  const handleCreate = async () => {
    setSaving(true); setError(null);
    try {
      const connector = await opsApi.createConnector(buildOpsConnectorInput(form));
      setConnectors((prev) => [...prev, connector]);
      setShowForm(false);
      setForm({
        mode: inClusterAvailable ? 'in-cluster' : 'kubeconfig',
        name: '',
        environment: 'prod',
        clusterName: '',
        namespaces: '',
        kubeconfig: '',
        context: '',
        apiServer: '',
        token: '',
        caData: '',
        insecureSkipTlsVerify: false,
        capabilities: { read: true, propose: true, execute_approved: false },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Ops connector');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id); setError(null);
    try {
      const result = await opsApi.testConnector(id);
      setTestMessages((prev) => ({ ...prev, [id]: result.message }));
      await loadConnectors();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to test Ops connector');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await opsApi.deleteConnector(id);
      setConnectors((prev) => prev.filter((connector) => connector.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete Ops connector');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <span className="inline-block w-6 h-6 border-2 border-[var(--color-outline-variant)] border-t-[var(--color-primary)] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--color-on-surface-variant)]">
            {connectors.length > 0
              ? `${connectors.length} connector${connectors.length === 1 ? '' : 's'} configured`
              : 'Not connected'}
          </p>
          <p className="text-xs text-[var(--color-outline)] mt-0.5">
            Cluster tools stay unavailable until a connector is configured.
          </p>
        </div>
        {!showForm && canWrite && (
          <button type="button" onClick={() => setShowForm(true)} className={btnPrimary}>
            Connect
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-[#EF4444]/25 bg-[#EF4444]/10 px-3 py-2 text-sm text-[#EF4444]">
          {error}
        </div>
      )}

      {showForm && canWrite && (
        <div className="space-y-5 p-4 bg-[var(--color-surface-highest)] rounded-xl border border-[var(--color-outline-variant)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-on-surface)]">Connect Kubernetes</h3>
              <p className="text-xs text-[var(--color-on-surface-variant)] mt-0.5">
                Choose how OpenObs should reach the cluster, then restrict what the agent may do.
              </p>
            </div>
            <span className="px-2 py-1 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)] text-[10px] font-semibold shrink-0">
              guided setup
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <Field label="Name">
              <input type="text" value={form.name} onChange={(e) => updateForm({ name: e.target.value })} placeholder="Production Kubernetes" className={inputCls} />
            </Field>
            <Field label="Environment">
              <input type="text" value={form.environment} onChange={(e) => updateForm({ environment: e.target.value })} placeholder="prod" className={inputCls} />
            </Field>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[var(--color-on-surface)] mb-2">1. Connection method</label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {inClusterAvailable && (
                <label className={`rounded-lg border p-3 cursor-pointer transition-colors ${form.mode === 'in-cluster' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--color-outline-variant)] hover:border-[var(--color-outline)]'}`}>
                  <input
                    type="radio"
                    name="ops-mode"
                    checked={form.mode === 'in-cluster'}
                    onChange={() => updateForm({ mode: 'in-cluster' })}
                    className="sr-only"
                  />
                  <span className="block text-sm font-medium text-[var(--color-on-surface)]">In-cluster</span>
                  <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-[#22C55E]/10 text-[#22C55E] text-[10px] font-semibold">recommended</span>
                  <span className="block text-[11px] text-[var(--color-on-surface-variant)] mt-2">Use the gateway pod's service account. No credentials to paste.</span>
                </label>
              )}
              <label className={`rounded-lg border p-3 cursor-pointer transition-colors ${form.mode === 'kubeconfig' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--color-outline-variant)] hover:border-[var(--color-outline)]'}`}>
                <input
                  type="radio"
                  name="ops-mode"
                  checked={form.mode === 'kubeconfig'}
                  onChange={() => updateForm({ mode: 'kubeconfig' })}
                  className="sr-only"
                />
                <span className="block text-sm font-medium text-[var(--color-on-surface)]">Paste kubeconfig</span>
                <span className="block text-[11px] text-[var(--color-on-surface-variant)] mt-2">Best when you already have a service-account kubeconfig.</span>
              </label>
              <label className={`rounded-lg border p-3 cursor-pointer transition-colors ${form.mode === 'manual' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--color-outline-variant)] hover:border-[var(--color-outline)]'}`}>
                <input
                  type="radio"
                  name="ops-mode"
                  checked={form.mode === 'manual'}
                  onChange={() => updateForm({ mode: 'manual' })}
                  className="sr-only"
                />
                <span className="block text-sm font-medium text-[var(--color-on-surface)]">API server + token</span>
                <span className="block text-[11px] text-[var(--color-on-surface-variant)] mt-2">Advanced path for manually issued bearer tokens.</span>
              </label>
            </div>
          </div>

          {form.mode === 'kubeconfig' && (
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-[var(--color-on-surface)]">2. Import kubeconfig</label>
              <Field label="Kubeconfig">
                <textarea value={form.kubeconfig} onChange={(e) => updateKubeconfig(e.target.value)} rows={7} placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: ..." className={inputCls + ' resize-y font-mono text-xs'} />
              </Field>
              {kubeconfigPreview && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)]/50 p-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--color-outline)]">Cluster</div>
                    <div className="text-xs text-[var(--color-on-surface)] truncate">{kubeconfigPreview.clusterName ?? 'Not detected'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--color-outline)]">Context</div>
                    <div className="text-xs text-[var(--color-on-surface)] truncate">{kubeconfigPreview.context ?? 'Not detected'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--color-outline)]">API server</div>
                    <div className="text-xs text-[var(--color-on-surface)] truncate">{kubeconfigPreview.apiServer ?? 'Not detected'}</div>
                  </div>
                </div>
              )}
              {kubeconfigPreview?.unreachableFromGateway && (
                <p className="text-xs text-[#F59E0B] bg-[#F59E0B]/10 border border-[#F59E0B]/20 rounded px-3 py-2">
                  This address is only reachable from your machine. The openobs gateway runs in a container/cluster and cannot reach it. Use <code className="font-mono">kubectl config view --flatten --minify</code> from a reachable jump host, or use In-cluster mode.
                </p>
              )}
              <Field label="Context" hint="Optional. Leave blank to use the kubeconfig's current-context.">
                <input type="text" value={form.context} onChange={(e) => updateForm({ context: e.target.value })} placeholder="prod-admin" className={inputCls} />
              </Field>
            </div>
          )}

          {form.mode === 'manual' && (
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-[var(--color-on-surface)]">2. Cluster credentials</label>
              <Field label="API Server URL">
                <input type="url" value={form.apiServer} onChange={(e) => updateForm({ apiServer: e.target.value })} placeholder="https://kubernetes.example.com:6443" className={inputCls} />
              </Field>
              {isLocalhostApiServer(form.apiServer) && (
                <p className="text-xs text-[#F59E0B] bg-[#F59E0B]/10 border border-[#F59E0B]/20 rounded px-3 py-2">
                  This address is only reachable from your machine. The openobs gateway runs in a container/cluster and cannot reach it. Use <code className="font-mono">kubectl config view --flatten --minify</code> from a reachable jump host, or use In-cluster mode.
                </p>
              )}
              <Field label="Bearer Token">
                <input type="password" value={form.token} onChange={(e) => updateForm({ token: e.target.value })} placeholder="Service account token" className={inputCls} />
              </Field>
              <Field label="CA Certificate (optional)" hint="PEM-encoded. Leave blank if using skip TLS verify.">
                <textarea value={form.caData} onChange={(e) => updateForm({ caData: e.target.value })} rows={3} placeholder="-----BEGIN CERTIFICATE-----&#10;..." className={inputCls + ' resize-y font-mono text-xs'} />
              </Field>
              <label className="flex items-center gap-2 text-xs text-[var(--color-on-surface-variant)] cursor-pointer">
                <input type="checkbox" checked={form.insecureSkipTlsVerify} onChange={(e) => updateForm({ insecureSkipTlsVerify: e.target.checked })} className="w-3.5 h-3.5 rounded accent-[var(--color-primary)]" />
                Skip TLS verify (insecure — only for dev/lab clusters)
              </label>
            </div>
          )}

          {form.mode === 'in-cluster' && (
            <div className="rounded-lg border border-[#22C55E]/20 bg-[#22C55E]/10 px-3 py-2">
              <p className="text-xs text-[#22C55E] font-medium">Service account detected</p>
              <p className="text-xs text-[var(--color-on-surface-variant)] mt-0.5">
                OpenObs will build a kubeconfig from the gateway pod's mounted token and certificate.
              </p>
            </div>
          )}

          <div className="space-y-3">
            <label className="block text-xs font-semibold text-[var(--color-on-surface)]">3. Access boundary</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Cluster name" hint="Shown to the agent and operators.">
                <input type="text" value={form.clusterName} onChange={(e) => updateForm({ clusterName: e.target.value })} placeholder="prod-east" className={inputCls} />
              </Field>
              <Field label="Namespaces" hint="Comma or newline separated. Blank allows cluster-scoped reads; writes still require an explicit namespace.">
                <input type="text" value={form.namespaces} onChange={(e) => updateForm({ namespaces: e.target.value })} placeholder="default, api, payments" className={inputCls} />
              </Field>
            </div>
            <div className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)]/40 p-3">
              <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-2">Agent permissions</label>
              <div className="space-y-2">
                {OPS_CAPABILITIES.map((capability) => (
                  <label key={capability.id} className="flex items-start gap-2 text-sm text-[var(--color-on-surface-variant)]">
                    <input
                      type="checkbox"
                      checked={form.capabilities[capability.id]}
                      onChange={(e) => updateForm({ capabilities: { ...form.capabilities, [capability.id]: e.target.checked } })}
                      className="mt-0.5 w-3.5 h-3.5 rounded accent-[var(--color-primary)]"
                    />
                    <span>
                      <span className="text-[var(--color-on-surface)]">{capability.label}</span>
                      {capability.id === 'execute_approved' && (
                        <span className="block text-[11px] text-[var(--color-outline)]">Requires the existing approval workflow before any write command runs.</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
            <button type="button" onClick={() => setShowForm(false)} className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] transition-colors">Cancel</button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={
                saving
                || !form.name.trim()
                || (form.mode === 'kubeconfig' && !form.kubeconfig.trim())
                || (form.mode === 'manual' && (!form.apiServer.trim() || !form.token.trim()))
              }
              className={btnPrimary + ' !py-1.5 !px-3 !text-xs'}
            >
              {saving ? 'Connecting...' : 'Connect cluster'}
            </button>
          </div>
        </div>
      )}

      {connectors.length === 0 && !showForm && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="w-12 h-12 rounded-xl bg-[var(--color-surface-high)] flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-[var(--color-outline)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M7 7v10a2 2 0 002 2h6a2 2 0 002-2V7M9 12h6M9 15h4" />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-on-surface-variant)] mb-1">No Ops integrations connected</p>
          <p className="text-xs text-[var(--color-outline)]">Kubernetes cluster tools will show not connected until a connector is added.</p>
        </div>
      )}

      {connectors.map((connector) => (
        <div key={connector.id} className="rounded-xl border border-[var(--color-outline-variant)] px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M7 7v10a2 2 0 002 2h6a2 2 0 002-2V7M9 12h6M9 15h4" /></svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-on-surface)]">{connector.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${connector.status === 'connected' ? 'bg-[#22C55E]/10 text-[#22C55E] border-[#22C55E]/20' : 'bg-[var(--color-on-surface-variant)]/10 text-[var(--color-on-surface-variant)] border-[var(--color-outline-variant)]'}`}>
                  {connector.status === 'connected' ? 'Connected' : 'Not connected'}
                </span>
                {connector.environment && <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${ENV_STYLES[connector.environment] ?? ENV_STYLES.custom}`}>{connector.environment}</span>}
              </div>
              <p className="mt-1 text-xs text-[var(--color-outline)] font-mono">{connector.id}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(connector.allowedNamespaces ?? []).map((namespace) => (
                  <span key={namespace} className="px-1.5 py-0.5 rounded bg-[var(--color-surface-high)] text-[10px] text-[var(--color-on-surface-variant)]">{namespace}</span>
                ))}
                {(connector.capabilities ?? []).map((capability) => (
                  <span key={capability} className="px-1.5 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)] text-[10px]">{capability}</span>
                ))}
              </div>
              {testMessages[connector.id] && (
                <p className="mt-2 text-xs text-[var(--color-on-surface-variant)]">{testMessages[connector.id]}</p>
              )}
              {canWrite && (
                <div className="mt-3 flex items-center gap-2">
                  <button type="button" onClick={() => void handleTest(connector.id)} disabled={testingId === connector.id} className={btnSecondary + ' !py-1.5 !px-3 !text-xs'}>
                    {testingId === connector.id ? 'Testing...' : 'Test'}
                  </button>
                  <button type="button" onClick={() => void handleDelete(connector.id)} className="px-3 py-1.5 rounded-lg text-xs text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors">
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── LLM Tab ───

function LlmTab({ canWrite }: { canWrite: boolean }) {
  const [config, setConfig] = useState<LlmConfig>({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '', region: '', authType: 'api-key', apiKeyHelper: '', apiFormat: 'anthropic' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);
  const [modelsWarning, setModelsWarning] = useState<string | null>(null);

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
          apiKeyHelper: res.data.llm!.apiKeyHelper ?? '',
          apiFormat: res.data.llm!.apiFormat ?? prev.apiFormat,
        }));
      }
    });
  }, []);

  const provider = LLM_PROVIDERS.find((p) => p.value === config.provider) ?? LLM_PROVIDERS[0]!;
  // Only fetched models are selectable — no manual entry, no fallback list.
  const availableModels = remoteModels.map((m) => ({
    id: m.id,
    label: m.description ? `${m.name} (${m.description})` : m.name,
  }));

  const handleFetchModels = async () => {
    setFetchingModels(true); setRemoteModels([]); setModelsFetched(false); setModelsWarning(null);
    try {
      const res = await apiClient.post<{ models: ModelInfo[] }>('/setup/llm/models', {
        provider: config.provider,
        apiKey: config.apiKey || undefined,
        baseUrl: config.baseUrl || undefined,
        apiKeyHelper: config.apiKeyHelper || undefined,
        apiFormat: config.provider === 'corporate-gateway' ? config.apiFormat : undefined,
      });
      if (res.data?.models?.length) {
        setRemoteModels(res.data.models);
        if (!res.data.models.map((m) => m.id).includes(config.model)) setConfig((prev) => ({ ...prev, model: res.data!.models[0]!.id }));
      }
      if (res.error) setModelsWarning(res.error.message);
      else if (!res.data?.models?.length) setModelsWarning('Provider returned no models.');
    } catch (err) {
      setModelsWarning(err instanceof Error ? err.message : 'Failed to fetch models');
    } finally {
      setFetchingModels(false); setModelsFetched(true);
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
      apiKeyHelper: config.apiKeyHelper || undefined,
      apiFormat: config.provider === 'corporate-gateway' ? config.apiFormat : undefined,
    });
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/llm/test', {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        region: config.region,
        authType: config.authType,
        apiKeyHelper: config.apiKeyHelper || undefined,
        apiFormat: config.provider === 'corporate-gateway' ? config.apiFormat : undefined,
      });
      setTestResult(res.error ? { ok: false, message: res.error.message } : res.data);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Provider</label>
        <select value={config.provider} onChange={(e) => {
          const p = e.target.value as LlmProvider;
          setConfig((prev) => ({
            ...prev,
            provider: p,
            // No default model — user must Fetch + pick.
            model: '',
            apiKey: '',
            baseUrl: '',
            region: '',
            authType: p === 'corporate-gateway' ? 'bearer' : 'api-key',
            apiKeyHelper: '',
            apiFormat: 'anthropic',
          }));
          setTestResult(null); setRemoteModels([]); setModelsFetched(false);
          setModelsWarning(null);
        }} className={selectCls}>{LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
      </div>

      {config.provider === 'corporate-gateway' && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Upstream API format</label>
          <select
            value={config.apiFormat}
            onChange={(e) => {
              setConfig((prev) => ({ ...prev, apiFormat: e.target.value as LlmConfig['apiFormat'] }));
              setRemoteModels([]); setModelsFetched(false); setModelsWarning(null); setTestResult(null);
            }}
            className={selectCls}
          >
            <option value="anthropic">Anthropic Messages API</option>
            <option value="openai">OpenAI Chat Completions API</option>
            <option value="gemini">Google Gemini generateContent</option>
            <option value="anthropic-bedrock">Anthropic on Bedrock (/model/&#123;id&#125;/invoke)</option>
          </select>
        </div>
      )}

      {provider.needsKey && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">API Key (optional if helper or upstream auth is used)</label>
          <input type="password" value={config.apiKey} onChange={(e) => { setConfig((prev) => ({ ...prev, apiKey: e.target.value })); setTestResult(null); setModelsWarning(null); }} placeholder="sk-... (leave blank for helper / unauth gateway)" className={inputCls} />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">API key helper (optional)</label>
        <input
          type="text"
          value={config.apiKeyHelper}
          onChange={(e) => { setConfig((prev) => ({ ...prev, apiKeyHelper: e.target.value })); setTestResult(null); setModelsWarning(null); }}
          placeholder='e.g. aws-vault exec my-profile -- printenv ANTHROPIC_API_KEY'
          className={inputCls + ' font-mono'}
        />
        <p className="text-xs text-[var(--color-on-surface-variant)] mt-1">
          Shell command whose stdout is the API key. Wins over the static key when set; cached for 5 minutes per command.
        </p>
      </div>

      {provider.needsUrl && (
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">{config.provider === 'ollama' ? 'Ollama URL' : 'Endpoint URL'}</label>
          <input type="text" value={config.baseUrl} onChange={(e) => { setConfig((prev) => ({ ...prev, baseUrl: e.target.value })); setModelsWarning(null); }} placeholder={llmBaseUrlPlaceholder(config.provider)} className={inputCls} />
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
        {modelsFetched && remoteModels.length === 0 && <p className="text-xs text-tertiary mt-1">{modelsWarning ?? 'Could not fetch models. Check your API key / URL.'}</p>}
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
  const canWriteChangeSources = !!user && (
    user.isServerAdmin ||
    hasPermission('datasources:write') ||
    hasPermission('instance.config:write')
  );
  // LLM / Notifications / Danger reset: gated by the canonical
  // `instance.config:write` action (granted to Admin+ via
  // ADMIN_ONLY_PERMISSIONS in roles-def.ts). Matches the backend enforcement
  // in routes/system.ts + routes/setup.ts reset endpoint.
  const canAdminWrite = !!user && (user.isServerAdmin || hasPermission('instance.config:write'));
  const canOpsWrite = !!user && (
    user.isServerAdmin ||
    hasPermission('ops.connectors:write') ||
    hasPermission('instance.config:write')
  );

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
            {tab === 'github' && 'Ingest deployments from GitHub as change events for investigations.'}
            {tab === 'ops' && 'Connect Kubernetes clusters for diagnostics and approved remediation.'}
            {tab === 'llm' && 'Configure the AI model used for investigations and analysis.'}
            {tab === 'notifications' && 'Set up alert delivery channels.'}
            {tab === 'danger' && 'Irreversible actions for your OpenObs instance.'}
          </p>

          {tab === 'datasources' && (
            <DataSourcesTab canCreate={canCreateDs} canWrite={canWriteDs} canDelete={canDeleteDs} />
          )}
          {tab === 'github' && <GitHubChangeSourcesTab canWrite={canWriteChangeSources} />}
          {tab === 'ops' && <OpsIntegrationsTab canWrite={canOpsWrite} />}
          {tab === 'llm' && <LlmTab canWrite={canAdminWrite} />}
          {tab === 'notifications' && <NotificationsTab canWrite={canAdminWrite} />}
          {tab === 'danger' && <DangerTab canReset={canAdminWrite} />}
        </div>
      </div>
    </div>
  );
}
