import React, { useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';
import { ModelCombobox } from '../components/ModelCombobox.js';
import ConnectorsPanel from '../components/connectors/ConnectorsPanel.js';
import KnowledgeTab from '../components/knowledge/KnowledgeTab.js';
import { llmBaseUrlPlaceholder } from '../constants/placeholders.js';
import { LLM_PROVIDERS } from './setup/types.js';
import type { LlmProvider, LlmConfig } from './setup/types.js';
import { useAuth } from '../contexts/AuthContext.js';
import type { ConnectorCredentialKind } from '@agentic-obs/common';

/**
 * Builds the secret string to POST to /connectors/:id/secret, or returns null
 * to skip the upload entirely. Exported for unit testing — keeps the per-kind
 * shape rules out of the React component.
 *
 * - `'none'` always returns null (no secret endpoint call).
 * - `'token'` / `'kubeconfig'` / unknown kinds: return trimmed `secret` if
 *   non-empty, else null. Leading/trailing whitespace from paste is preserved
 *   for kubeconfig (YAML is whitespace-sensitive) — we only trim `'token'`.
 * - `'basic'`: requires BOTH username and password; returns
 *   `JSON.stringify({ username, password })`. If only one is filled, returns
 *   `{ error: 'incomplete-basic' }` so the caller can surface a validation
 *   error before submit.
 */
export type SecretBuildResult =
  | { kind: 'skip' }
  | { kind: 'send'; value: string }
  | { kind: 'error'; message: string };

export function buildSecretValue(
  credential: ConnectorCredentialKind,
  secret: string,
  username: string,
  password: string,
): SecretBuildResult {
  if (credential === 'none') return { kind: 'skip' };
  if ((credential as string) === 'basic') {
    const u = username.trim();
    const p = password;
    if (!u && !p) return { kind: 'skip' };
    if (!u || !p) {
      return { kind: 'error', message: 'Both username and password are required for basic auth.' };
    }
    return { kind: 'send', value: JSON.stringify({ username: u, password: p }) };
  }
  if (credential === 'token') {
    const trimmed = secret.trim();
    return trimmed ? { kind: 'send', value: trimmed } : { kind: 'skip' };
  }
  // 'kubeconfig' and any future/defensive kinds: don't trim — YAML/PEM payloads
  // can be whitespace-sensitive, but blanks (no non-whitespace chars) skip.
  if (secret.trim() === '') return { kind: 'skip' };
  return { kind: 'send', value: secret };
}

/**
 * Minimal shape of the api client used by `submitConnectorWithSecret`. Lets
 * tests inject a recording double without dragging in the real fetch layer.
 */
export interface ConnectorSubmitApi {
  post<T>(
    path: string,
    body: unknown,
  ): Promise<{ data?: T | null; error?: { message?: string } | null }>;
}

export interface ConnectorSubmitInput {
  type: string;
  name: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  id?: string;
  credential: ConnectorCredentialKind;
  secret: string;
  basicUsername: string;
  basicPassword: string;
}

export type ConnectorSubmitResult =
  | { kind: 'ok'; connectorId: string }
  | { kind: 'validation-error'; message: string }
  | { kind: 'create-failed'; message: string }
  | { kind: 'secret-failed'; connectorId: string; message: string };

/**
 * The two-call create flow: POST /connectors → POST /connectors/:id/secret.
 * Pulled out of the React component so the ordering / error-handling rules
 * can be unit-tested without a DOM.
 *
 * Contract:
 * - Validation errors short-circuit BEFORE the create call.
 * - A failed create returns `'create-failed'` (no secret call attempted).
 * - A failed secret upload returns `'secret-failed'` but treats the connector
 *   as created (UI surfaces an inline error and keeps the row).
 * - When `buildSecretValue` returns `'skip'` no secret call is made.
 */
export async function submitConnectorWithSecret(
  api: ConnectorSubmitApi,
  input: ConnectorSubmitInput,
): Promise<ConnectorSubmitResult> {
  const secret = buildSecretValue(
    input.credential,
    input.secret,
    input.basicUsername,
    input.basicPassword,
  );
  if (secret.kind === 'error') {
    return { kind: 'validation-error', message: secret.message };
  }

  const body: Record<string, unknown> = {
    type: input.type,
    name: input.name,
    config: input.config,
    isDefault: input.isDefault,
  };
  if (input.id && input.id.trim()) body['id'] = input.id.trim();

  const createRes = await api.post<{ connector: { id: string } }>(
    '/connectors',
    body,
  );
  if (createRes.error) {
    return { kind: 'create-failed', message: createRes.error.message ?? 'Failed to create connector' };
  }
  const connectorId = createRes.data?.connector?.id;
  if (!connectorId) {
    return { kind: 'create-failed', message: 'Connector created but no id returned' };
  }

  if (secret.kind === 'send') {
    const secretRes = await api.post(`/connectors/${connectorId}/secret`, {
      secret: secret.value,
    });
    if (secretRes.error) {
      return {
        kind: 'secret-failed',
        connectorId,
        message: secretRes.error.message ?? 'unknown error',
      };
    }
  }
  return { kind: 'ok', connectorId };
}

interface ModelInfo { id: string; name: string; provider: string; description?: string; }

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] text-[var(--color-on-surface)] text-sm placeholder-[var(--color-outline)] focus:outline-none focus:border-[var(--color-primary)] transition-colors';
const selectCls = inputCls;
const btnPrimary = 'px-4 py-2 rounded-lg bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)] text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity';
const btnSecondary = 'px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] text-sm font-medium text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors';

type SettingsTab = 'connectors' | 'knowledge' | 'ai' | 'notifications' | 'account' | 'danger';

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'connectors', label: 'Connectors', icon: <span className="text-xs font-bold">C</span> },
  { id: 'knowledge', label: 'Knowledge', icon: <span className="text-xs font-bold">K</span> },
  { id: 'ai', label: 'AI Provider', icon: <span className="text-xs font-bold">AI</span> },
  { id: 'notifications', label: 'Notifications', icon: <span className="text-xs font-bold">N</span> },
  { id: 'account', label: 'Account', icon: <span className="text-xs font-bold">A</span> },
  { id: 'danger', label: 'Reset', icon: <span className="text-xs font-bold">!</span> },
];

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
  // Prefer fetched models, but fall back to the provider's known list so
  // providers without a /models endpoint (e.g. corporate-gateway) still
  // surface options. The Default Model field is also free-text via
  // <datalist> so users can type any model the upstream supports.
  const availableModels = (remoteModels.length > 0
    ? remoteModels.map((m) => ({
        id: m.id,
        label: m.description ? `${m.name} (${m.description})` : m.name,
      }))
    : provider.fallbackModels.map((id) => ({ id, label: id })));

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
          <ModelCombobox
            value={config.model}
            onChange={(next) => setConfig((prev) => ({ ...prev, model: next }))}
            options={availableModels}
            placeholder="model id"
            inputClassName={inputCls + ' w-full'}
            className="flex-1 min-w-0"
          />
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


function AccountTab() {
  const { user } = useAuth();
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-xs font-medium text-[var(--color-on-surface-variant)]">Signed in as</p>
        <p className="mt-1 text-[var(--color-on-surface)]">{user?.email ?? user?.name ?? 'Unknown user'}</p>
      </div>
      <div>
        <p className="text-xs font-medium text-[var(--color-on-surface-variant)]">Role</p>
        <p className="mt-1 text-[var(--color-on-surface)]">{user?.isServerAdmin ? 'Server admin' : 'Member'}</p>
      </div>
    </div>
  );
}

export default function Settings() {
  const [tab, setTab] = useState<SettingsTab>('connectors');
  const { user, hasPermission } = useAuth();
  const canWriteConnectors = !!user && (user.isServerAdmin || hasPermission('connectors:write') || hasPermission('instance.config:write'));
  // AI provider / Notifications / Danger reset: gated by the canonical
  // `instance.config:write` action (granted to Admin+ via
  // ADMIN_ONLY_PERMISSIONS in roles-def.ts). Matches the backend enforcement
  // in routes/system.ts + routes/setup.ts reset endpoint.
  const canAdminWrite = !!user && (user.isServerAdmin || hasPermission('instance.config:write'));

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

      {/* Right content area. The Connectors tab opts out of the page padding +
          max-width because it owns a full-bleed 2-pane (list + detail) layout. */}
      {tab === 'connectors' ? (
        <div className="flex-1 min-w-0 overflow-hidden">
          <ConnectorsPanel canWrite={canWriteConnectors} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-6 px-8">
          <div className="max-w-2xl">
            <h2 className="text-base font-semibold text-[var(--color-on-surface)] mb-1">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <p className="text-sm text-[var(--color-on-surface-variant)] mb-6">
              {tab === 'knowledge' && 'Knowledge entries the agent consults for dashboards, metric meaning, and patterns. Bundled entries ship with Rounds and cannot be edited.'}
              {tab === 'ai' && 'Configure the AI model used for investigations and analysis.'}
              {tab === 'notifications' && 'Set up alert delivery channels.'}
              {tab === 'account' && 'Review your account details.'}
              {tab === 'danger' && 'Irreversible actions for your Rounds instance.'}
            </p>

            {tab === 'knowledge' && <KnowledgeTab canWrite={canWriteConnectors} />}
            {tab === 'ai' && <LlmTab canWrite={canAdminWrite} />}
            {tab === 'notifications' && <NotificationsTab canWrite={canAdminWrite} />}
            {tab === 'account' && <AccountTab />}
            {tab === 'danger' && <DangerTab canReset={canAdminWrite} />}
          </div>
        </div>
      )}
    </div>
  );
}
