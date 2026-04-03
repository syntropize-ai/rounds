import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';

// Types

type DatasourceType =
  | 'prometheus'
  | 'victoria-metrics'
  | 'loki'
  | 'elasticsearch'
  | 'tempo'
  | 'jaeger'
  | 'clickhouse'
  | 'otel';

type AuthType = 'none' | 'basic' | 'bearer';
type EnvType = 'prod' | 'staging' | 'dev' | 'test' | 'custom';

interface DatasourceConfig {
  id: string;
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
}

// Constants

const DS_TYPES: Array<{ value: DatasourceType; label: string; icon: string; color: string }> = [
  { value: 'prometheus', label: 'Prometheus', icon: 'P', color: '#06E5F2' },
  { value: 'victoria-metrics', label: 'Victoria Metrics', icon: 'VM', color: '#D2619CA' },
  { value: 'loki', label: 'Loki', icon: 'L', color: '#7FA835' },
  { value: 'elasticsearch', label: 'Elasticsearch', icon: 'ES', color: '#00B0F3' },
  { value: 'tempo', label: 'Tempo', icon: 'T', color: '#FF701F' },
  { value: 'jaeger', label: 'Jaeger', icon: 'J', color: '#400963' },
  { value: 'clickhouse', label: 'ClickHouse', icon: 'CH', color: '#FFCC00' },
  { value: 'otel', label: 'OpenTelemetry', icon: 'OT', color: '#4FCFD7' },
];

const ENV_OPTIONS: EnvType[] = ['prod', 'staging', 'dev', 'test', 'custom'];

const ENV_STYLES: Record<string, string> = {
  prod: 'bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/20',
  staging: 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/20',
  dev: 'bg-[#22C55E]/10 text-[#22C55E] border-[#22C55E]/20',
  test: 'bg-[#6366F1]/10 text-[#6366F1] border-[#6366F1]/20',
  custom: 'bg-[#8888AA]/10 text-[#8888AA] border-[#8888AA]/20',
};

function dsInfo(type: DatasourceType) {
  return DS_TYPES.find((d) => d.value === type) ?? DS_TYPES[0];
}

// Type icon

function TypeIcon({ type, size = 'sm' }: { type: DatasourceType; size?: 'sm' | 'md' }) {
  const info = dsInfo(type);
  const cls =
    size === 'md'
      ? 'w-8 h-8 rounded-lg text-[11px] font-bold flex items-center justify-center shrink-0'
      : 'w-6 h-6 rounded text-[9px] font-bold flex items-center justify-center shrink-0';

  return (
    <span className={cls} style={{ backgroundColor: `${info!.color}20`, color: info!.color }}>
      {info!.icon}
    </span>
  );
}

// Status dot

type ConnStatus = 'connected' | 'error' | 'unknown';

function StatusDot({ status }: { status: ConnStatus }) {
  if (status === 'connected') {
    return <span className="w-2 h-2 rounded-full bg-[#22C55E] shrink-0" title="Connected" />;
  }
  if (status === 'error') {
    return <span className="w-2 h-2 rounded-full bg-[#EF4444] shrink-0" title="Error" />;
  }
  return <span className="w-2 h-2 rounded-full bg-[#555570] shrink-0" title="Unknown" />;
}

// Input components

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-[#E8E8ED] mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-[#555570]">{hint}</p>}
    </div>
  );
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#0A0A0F] text-[#E8E8ED] text-sm placeholder-[#555570] focus:outline-none focus:border-[#6366F1] transition-colors';

const selectCls =
  'w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#0A0A0F] text-[#E8E8ED] text-sm focus:outline-none focus:border-[#6366F1] transition-colors';

// Empty form state

function emptyForm(): Omit<DatasourceConfig, 'id'> & { authType: AuthType } {
  return {
    type: 'prometheus',
    name: '',
    url: '',
    environment: 'prod',
    cluster: '',
    label: '',
    isDefault: false,
    apiKey: '',
    username: '',
    password: '',
    authType: 'none',
  };
}

// Datasource form (shared by add + edit)

interface DsFormState extends Omit<DatasourceConfig, 'id'> {
  authType: AuthType;
}

interface TestResult {
  ok: boolean;
  message: string;
  version?: string;
}

function DatasourceForm({
  value,
  onChange,
  onSave,
  onCancel,
  onDelete,
  saving,
  isNew,
}: {
  value: DsFormState;
  onChange: (v: DsFormState) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  saving: boolean;
  isNew: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const set = (patch: Partial<DsFormState>) => {
    setTestResult(null);
    onChange({ ...value, ...patch });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const body: Record<string, unknown> = { url: value.url, type: value.type };
    if (value.authType === 'bearer' && value.apiKey) body.apiKey = value.apiKey;
    if (value.authType === 'basic') {
      body.username = value.username;
      body.password = value.password;
    }
    const res = await apiClient.post<TestResult>('/datasources/test', body);
    setTesting(false);
    if (res.error) {
      setTestResult({ ok: false, message: res.error.message ?? 'Connection failed' });
    } else {
      setTestResult(res.data);
    }
  };

  return (
    <div className="px-4 pb-4 pt-3 border-t border-[#1C1C2E] space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Type">
          <select
            value={value.type}
            onChange={(e) => set({ type: e.target.value as DatasourceType })}
            className={selectCls}
          >
            {DS_TYPES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Name">
          <input
            type="text"
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="My Prometheus"
            className={inputCls}
          />
        </Field>

        <Field label="URL" hint="e.g. http://prometheus:9090">
          <input
            type="url"
            value={value.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="http://localhost:9090"
            className={inputCls}
          />
        </Field>

        <Field label="Environment">
          <select
            value={value.environment ?? 'prod'}
            onChange={(e) => set({ environment: e.target.value as EnvType })}
            className={selectCls}
          >
            {ENV_OPTIONS.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Cluster" hint="Optional - e.g. us-east-1">
          <input
            type="text"
            value={value.cluster ?? ''}
            onChange={(e) => set({ cluster: e.target.value })}
            placeholder="cluster-name"
            className={inputCls}
          />
        </Field>

        <Field label="Label" hint="Short display label (optional)">
          <input
            type="text"
            value={value.label ?? ''}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="prod-metrics"
            className={inputCls}
          />
        </Field>

        <Field label="Authentication">
          <select
            value={value.authType}
            onChange={(e) => set({ authType: e.target.value as AuthType })}
            className={selectCls}
          >
            <option value="none">No Authentication</option>
            <option value="bearer">Bearer Token / API Key</option>
            <option value="basic">Basic Auth</option>
          </select>
        </Field>
      </div>

      {value.authType === 'bearer' && (
        <Field label="API Key / Token">
          <input
            type="password"
            value={value.apiKey ?? ''}
            onChange={(e) => set({ apiKey: e.target.value })}
            placeholder="Bearer token or API key"
            className={inputCls}
          />
        </Field>
      )}

      {value.authType === 'basic' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Username">
            <input
              type="text"
              value={value.username ?? ''}
              onChange={(e) => set({ username: e.target.value })}
              placeholder="admin"
              className={inputCls}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={value.password ?? ''}
              onChange={(e) => set({ password: e.target.value })}
              placeholder="••••••••"
              className={inputCls}
            />
          </Field>
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => {
            void handleTest();
          }}
          disabled={testing || !value.url}
          className="px-3 py-1.5 rounded-lg border border-[#2A2A3E] text-xs font-medium text-[#E8E8ED] hover:bg-[#0C1C2E] disabled:opacity-50 transition-colors"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>

        {testResult && (
          <span
            className={`text-xs font-medium ${
              testResult.ok ? 'text-[#22C55E]' : 'text-[#EF4444]'
            }`}
          >
            {testResult.ok ? 'Connected' : testResult.message}
            {testResult.ok && testResult.version && (
              <span className="text-[#8888AA] ml-1">({testResult.version})</span>
            )}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-[#1C1C2E]">
        <label className="flex items-center gap-2 text-xs text-[#8888AA] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={value.isDefault ?? false}
            onChange={(e) => set({ isDefault: e.target.checked })}
            className="w-3.5 h-3.5 rounded accent-[#6366F1]"
          />
          Set as default
        </label>

        <div className="flex-1" />

        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="px-2.5 py-1.5 rounded-lg text-xs text-[#555570] hover:text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
          >
            Delete
          </button>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1.5 rounded-lg text-xs text-[#8888AA] hover:bg-[#1C1C2E] transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !value.name || !value.url}
          className="px-3 py-1.5 rounded-lg bg-[#6366F1] text-white text-xs font-medium hover:bg-[#4F46E5] disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving...' : isNew ? 'Add Datasource' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// Datasource Row

function DatasourceRow({
  ds,
  expanded,
  onToggle,
  onSave,
  onDelete,
  onSetDefault,
}: {
  ds: DatasourceConfig;
  expanded: boolean;
  onToggle: () => void;
  onSave: (id: string, form: DsFormState) => Promise<void>;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const info = dsInfo(ds.type);
  const [form, setForm] = useState<DsFormState>({
    type: ds.type,
    name: ds.name,
    url: ds.url,
    environment: ds.environment ?? 'prod',
    cluster: ds.cluster ?? '',
    label: ds.label ?? '',
    isDefault: ds.isDefault ?? false,
    apiKey: ds.apiKey ?? '',
    username: ds.username ?? '',
    password: ds.password ?? '',
    authType: ds.apiKey ? 'bearer' : ds.username ? 'basic' : 'none',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      type: ds.type,
      name: ds.name,
      url: ds.url,
      environment: ds.environment ?? 'prod',
      cluster: ds.cluster ?? '',
      label: ds.label ?? '',
      isDefault: ds.isDefault ?? false,
      apiKey: ds.apiKey ?? '',
      username: ds.username ?? '',
      password: ds.password ?? '',
      authType: ds.apiKey ? 'bearer' : ds.username ? 'basic' : 'none',
    });
  }, [ds]);

  const handleSave = async () => {
    setSaving(true);
    await onSave(ds.id, form);
    setSaving(false);
  };

  const truncateUrl = (url: string) => {
    if (url.length <= 40) return url;
    return `${url.slice(0, 37)}...`;
  };

  return (
    <div className="rounded-xl border bg-[#141418] border-[#2A2A3E] hover:border-[#6366F1]/40 transition-all">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
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

        <TypeIcon type={ds.type} />

        <span className="text-sm font-medium text-[#E8E8ED] truncate min-w-0 max-w-[180px]">
          {ds.name}
        </span>

        {ds.isDefault && (
          <span className="px-1.5 py-0.5 rounded bg-[#6366F1]/15 text-[#818CF8] text-[10px] font-semibold shrink-0">
            Default
          </span>
        )}

        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0"
          style={{
            backgroundColor: `${info!.color}15`,
            color: info!.color,
            borderColor: `${info!.color}30`,
          }}
        >
          {info!.label}
        </span>

        {ds.environment && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${
              ENV_STYLES[ds.environment] ?? ENV_STYLES.custom
            }`}
          >
            {ds.environment}
          </span>
        )}

        {ds.cluster && (
          <span className="px-1.5 py-0.5 rounded bg-[#1C1C2E] text-[#8888AA] text-[10px] font-mono shrink-0 hidden md:inline">
            {ds.cluster}
          </span>
        )}

        <span className="text-[11px] text-[#555570] font-mono hidden md:inline truncate flex-1 text-right">
          {truncateUrl(ds.url)}
        </span>

        <StatusDot status="unknown" />
      </button>

      {expanded && (
        <DatasourceForm
          value={form}
          onChange={setForm}
          onSave={() => void handleSave()}
          onCancel={onToggle}
          onDelete={onDelete}
          saving={saving}
          isNew={false}
        />
      )}
    </div>
  );
}

// Add Datasource Panel

function AddDatasourcePanel({
  onSave,
  onCancel,
}: {
  onSave: (form: DsFormState) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<DsFormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-[#6366F1]/30 bg-[#141420]">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-[#1C1C2E]">
        <span className="text-sm font-semibold text-[#E8E8ED]">New Data Source</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="p-1 text-[#555570] hover:text-[#8888AA] transition-colors"
          aria-label="Close"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
      <DatasourceForm
        value={form}
        onChange={setForm}
        onSave={() => {
          void handleSave();
        }}
        onCancel={onCancel}
        saving={saving}
        isNew
      />
    </div>
  );
}

// Main

export default function Connections() {
  const [datasources, setDatasources] = useState<DatasourceConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  const loadDatasources = useCallback(async () => {
    const res = await apiClient.get<{ datasources: DatasourceConfig[] }>('/datasources');
    if (!res.error) setDatasources(res.data.datasources ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadDatasources();
  }, [loadDatasources]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAdd = useCallback(async (form: DsFormState) => {
    const body: Partial<DatasourceConfig> = {
      type: form.type,
      name: form.name,
      url: form.url,
      environment: form.environment,
      cluster: form.cluster || undefined,
      label: form.label || undefined,
      isDefault: form.isDefault,
    };
    if (form.authType === 'bearer' && form.apiKey) body.apiKey = form.apiKey;
    if (form.authType === 'basic') {
      body.username = form.username;
      body.password = form.password;
    }
    const res = await apiClient.post<{ datasource: DatasourceConfig }>('/datasources', body);
    if (!res.error) {
      setDatasources((prev) => [...prev, res.data.datasource]);
      setShowAddForm(false);
    }
  }, []);

  const handleUpdate = useCallback(async (id: string, form: DsFormState) => {
    const body: Partial<DatasourceConfig> = {
      type: form.type,
      name: form.name,
      url: form.url,
      environment: form.environment,
      cluster: form.cluster || undefined,
      label: form.label || undefined,
      isDefault: form.isDefault,
    };
    if (form.authType === 'bearer' && form.apiKey) body.apiKey = form.apiKey;
    if (form.authType === 'basic') {
      body.username = form.username;
      body.password = form.password;
    }
    const res = await apiClient.put<{ datasource: DatasourceConfig }>(`/datasources/${id}`, body);
    if (!res.error) {
      setDatasources((prev) => prev.map((d) => (d.id === id ? res.data.datasource : d)));
      setExpandedIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/datasources/${id}`);
    if (!res.error) {
      setDatasources((prev) => prev.filter((d) => d.id !== id));
    }
  }, []);

  const handleSetDefault = useCallback(
    async (id: string) => {
      const ds = datasources.find((d) => d.id === id);
      if (!ds) return;
      const res = await apiClient.put<{ datasource: DatasourceConfig }>(`/datasources/${id}`, {
        ...ds,
        isDefault: true,
      });
      if (!res.error) {
        setDatasources((prev) =>
          prev.map((d) => ({
            ...d,
            isDefault: d.id === id,
          }))
        );
      }
    },
    [datasources]
  );

  // Filtering

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return datasources;
    const q = searchQuery.toLowerCase();
    return datasources.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.type.toLowerCase().includes(q) ||
        (d.url ?? '').toLowerCase().includes(q) ||
        (d.environment ?? '').toLowerCase().includes(q) ||
        (d.cluster ?? '').toLowerCase().includes(q)
    );
  }, [datasources, searchQuery]);

  // Stats

  const counts = useMemo(() => {
    const c: Record<string, number> = { total: datasources.length };
    for (const d of datasources) {
      c[d.type] = (c[d.type] ?? 0) + 1;
    }
    return c;
  }, [datasources]);

  const topTypes = useMemo(
    () =>
      DS_TYPES.filter((t) => (counts[t.value] ?? 0) > 0)
        .map((t) => ({ ...t, count: counts[t.value] ?? 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4),
    [counts]
  );

  return (
    <div className="min-h-full bg-[#0A0A0F]">
      <div className="max-w-4xl mx-auto px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-xl font-bold text-[#E8E8ED]">Connections</h1>
          {!showAddForm && (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="px-3 py-1.5 bg-[#6366F1] text-white text-xs font-medium rounded-lg hover:bg-[#4F46E5] transition-colors"
            >
              Add data source
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-5">
          <span className="text-sm text-[#E8E8ED] font-medium">
            {counts.total} data source{counts.total === 1 ? '' : 's'}
          </span>
          {topTypes.map((t) => (
            <span
              key={t.value}
              className="px-2 py-0.5 rounded text-[11px] font-medium border"
              style={{
                backgroundColor: `${t.color}15`,
                color: t.color,
                borderColor: `${t.color}30`,
              }}
            >
              {t.count} {t.label.toLowerCase()}
            </span>
          ))}
        </div>

        <div className="relative mb-5">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555570]"
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
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, type, URL, environment..."
            className="w-full bg-[#141420] border border-[#2A2A3E] rounded-lg pl-9 pr-9 py-2 text-sm text-[#E8E8ED] placeholder-[#555570] focus:outline-none focus:border-[#6366F1] transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555570] hover:text-[#8888AA]"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
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

        {showAddForm && (
          <div className="mb-5">
            <AddDatasourcePanel
              onSave={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        )}

        {loading && (
          <div className="flex justify-center py-16">
            <span className="inline-block w-6 h-6 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
          </div>
        )}

        {!loading && datasources.length === 0 && !showAddForm && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#1A1A2E] border border-[#2A2A3E] flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-[#555570]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 7h16M4 12h16M4 17h10"
                />
              </svg>
            </div>
            <p className="text-sm text-[#8888AA] mb-1">No data sources configured</p>
            <p className="text-xs text-[#555570] mb-4">
              Add a Prometheus, Loki, or other data source to start querying
            </p>
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="px-4 py-2 bg-[#6366F1] text-white text-sm font-medium rounded-lg hover:bg-[#4F46E5] transition-colors"
            >
              Add data source
            </button>
          </div>
        )}

        {!loading && datasources.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center py-12 text-center">
            <p className="text-sm text-[#8888AA]">
              No data sources match <span className="text-[#60A5FA]">"{searchQuery}"</span>
            </p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-2 text-xs text-[#6366F1] hover:text-[#818CF8]"
            >
              Clear search
            </button>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((ds) => (
              <DatasourceRow
                key={ds.id}
                ds={ds}
                expanded={expandedIds.has(ds.id)}
                onToggle={() => toggleExpand(ds.id)}
                onSave={handleUpdate}
                onDelete={() => setDeletingId(ds.id)}
                onSetDefault={() => {
                  void handleSetDefault(ds.id);
                }}
              />
            ))}
          </div>
        )}

        <ConfirmDialog
          open={deletingId !== null}
          title="Delete data source"
          message="This data source will be permanently removed. Panels referencing it may stop working."
          onConfirm={() => {
            if (deletingId) void handleDelete(deletingId);
            setDeletingId(null);
          }}
          onCancel={() => setDeletingId(null)}
        />
      </div>
    </div>
  );
}
