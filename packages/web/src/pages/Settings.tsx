import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import ConnectorPoliciesDialog from '../components/ConnectorPoliciesDialog.js';
import { ModelCombobox } from '../components/ModelCombobox.js';
import { llmBaseUrlPlaceholder } from '../constants/placeholders.js';
import { LLM_PROVIDERS } from './setup/types.js';
import type { LlmProvider, LlmConfig } from './setup/types.js';
import { useAuth } from '../contexts/AuthContext.js';
import type { ConnectorType, ConnectorCredentialKind } from '@agentic-obs/common';
import { getConnectorTemplate } from '@agentic-obs/common';
import {
  ConnectorConfigFields,
  configIsValid,
  defaultsFor,
  reconcileConfig,
} from './connector-config-form.js';
import {
  getRegistrationStatus,
  getManifest,
  unregister as unregisterGithubApp,
  submitManifestForm,
  syncInstallations,
} from '../api/github-app-api.js';

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

const CONNECTOR_TYPES: ConnectorType[] = [
  'prometheus',
  'victoria-metrics',
  'loki',
  'elasticsearch',
  'clickhouse',
  'tempo',
  'jaeger',
  'otel',
  'kubernetes',
  'github',
];

interface ModelInfo { id: string; name: string; provider: string; description?: string; }

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] text-[var(--color-on-surface)] text-sm placeholder-[var(--color-outline)] focus:outline-none focus:border-[var(--color-primary)] transition-colors';
const selectCls = inputCls;
const btnPrimary = 'px-4 py-2 rounded-lg bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)] text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity';
const btnSecondary = 'px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] text-sm font-medium text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors';
const GITHUB_CONNECT_EVENT_KEY = 'rounds:github-connector-updated';

type SettingsTab = 'connectors' | 'ai' | 'notifications' | 'account' | 'danger';

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'connectors', label: 'Connectors', icon: <span className="text-xs font-bold">C</span> },
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

interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  category?: string[];
  capabilities?: string[];
  status: 'draft' | 'active' | 'failed' | 'disabled' | string;
  defaultFor?: string | null;
  lastVerifiedAt?: string | null;
  // Populated by GET /connectors so the Edit form can prefill without an
  // extra fetch. Secrets are NOT in here (kubeconfig, tokens, etc. live in
  // the secret table and are write-only via /connectors/:id/secret).
  config?: Record<string, unknown>;
  isDefault?: boolean;
}

interface CredentialsSectionProps {
  kind: ConnectorCredentialKind;
  secret: string;
  onSecretChange: (next: string) => void;
  basicUsername: string;
  onBasicUsernameChange: (next: string) => void;
  basicPassword: string;
  onBasicPasswordChange: (next: string) => void;
}

/**
 * Renders the per-kind credential input(s) for the Add Connector form. The
 * VALUES collected here are NOT part of the connector config blob — they are
 * POSTed separately to /connectors/:id/secret after the connector is created
 * (see handleCreate), so the backend can encrypt them via secret-box.
 *
 * `'none'` → nothing rendered. `'oauth'` / `'aws-keys'` / unknown future kinds
 * fall through to a defensive single-line input so the user can still attach
 * a credential value rather than being silently locked out.
 */
function CredentialsSection({
  kind,
  secret,
  onSecretChange,
  basicUsername,
  onBasicUsernameChange,
  basicPassword,
  onBasicPasswordChange,
}: CredentialsSectionProps) {
  if (kind === 'none') return null;

  const hintCls = 'text-xs text-[var(--color-on-surface-variant)] mt-1.5';
  const headingCls = 'text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]';
  const labelCls = 'block text-sm font-medium text-[var(--color-on-surface)] mb-1.5';

  return (
    <div data-testid="credentials-section" className="space-y-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
      <p className={headingCls}>Credentials</p>
      {kind === 'token' && (
        <div>
          <label className={labelCls}>Bearer token (optional)</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="Paste token — stored encrypted"
            className={inputCls}
            data-testid="credential-token"
          />
          <p className={hintCls}>
            Stored encrypted. Required for authenticated endpoints; leave blank for unauthenticated dev clusters.
          </p>
        </div>
      )}
      {kind === 'kubeconfig' && (
        <div>
          <label className={labelCls}>Kubeconfig YAML (optional)</label>
          <textarea
            rows={6}
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="Paste kubeconfig contents — leave blank to use in-cluster service account"
            className={inputCls + ' font-mono'}
            data-testid="credential-kubeconfig"
          />
          <p className={hintCls}>
            Required when rounds is OUTSIDE the target cluster. Leave blank when rounds runs IN the same cluster — the mounted service account at /var/run/secrets/kubernetes.io/serviceaccount/ is used automatically.
          </p>
        </div>
      )}
      {(kind as string) === 'basic' && (
        <div className="space-y-2">
          <div>
            <label className={labelCls}>Username</label>
            <input
              type="text"
              value={basicUsername}
              onChange={(e) => onBasicUsernameChange(e.target.value)}
              className={inputCls}
              data-testid="credential-basic-username"
            />
          </div>
          <div>
            <label className={labelCls}>Password</label>
            <input
              type="password"
              value={basicPassword}
              onChange={(e) => onBasicPasswordChange(e.target.value)}
              className={inputCls}
              data-testid="credential-basic-password"
            />
          </div>
          <p className={hintCls}>Stored encrypted as JSON &#123;username, password&#125;.</p>
        </div>
      )}
      {kind !== 'token' && kind !== 'kubeconfig' && (kind as string) !== 'basic' && (
        <div>
          <label className={labelCls}>Credential (optional)</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            className={inputCls}
            data-testid="credential-generic"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Test a configured connector against its real backend (POST /:id/test).
 * Result is rendered inline next to the button as a transient status pill —
 * green for ok, red for fail. Auto-clears after 8 s. Disabled while in flight.
 */
function TestConnectorButton({ connector, disabled }: { connector: ConnectorRow; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await apiClient.post<{ ok: boolean; message?: string; detail?: string }>(
        `/connectors/${connector.id}/test`,
        {},
      );
      if (res.error) {
        setResult({ ok: false, message: res.error.message ?? 'Test failed' });
      } else {
        setResult({
          ok: !!res.data?.ok,
          message: res.data?.message ?? res.data?.detail,
        });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setBusy(false);
    }
  }, [busy, connector.id]);

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 8000);
    return () => clearTimeout(t);
  }, [result]);

  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <button
        type="button"
        disabled={disabled || busy}
        className={`${btnSecondary} shrink-0`}
        onClick={() => void run()}
      >
        {busy ? 'Testing…' : 'Test'}
      </button>
      {result && (
        <span
          className={`max-w-[22rem] whitespace-normal break-words rounded px-2 py-1 text-left text-[11px] leading-snug ${
            result.ok
              ? 'bg-secondary/10 text-secondary'
              : 'bg-error/10 text-error'
          }`}
          title={result.message ?? ''}
        >
          {result.ok ? 'OK' : result.message ? `Cannot connect: ${result.message}` : 'Test failed'}
        </span>
      )}
    </div>
  );
}

/**
 * Delete a connector after an inline confirm step. The first click flips
 * the button into a "Confirm delete?" red state for ~4 s; a second click
 * within that window actually fires DELETE /:id. The two-click model avoids
 * accidental deletes without bouncing through a modal.
 */
function DeleteConnectorButton({
  connector,
  disabled,
  onDeleted,
}: {
  connector: ConnectorRow;
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const run = useCallback(async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      const res = await apiClient.delete(`/connectors/${connector.id}`);
      if (res.error) {
        setError(res.error.message ?? 'Delete failed');
      } else {
        onDeleted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }, [armed, busy, connector.id, onDeleted]);

  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <button
        type="button"
        disabled={disabled || busy}
        className={`${btnSecondary} shrink-0 ${armed ? 'border-error text-error' : ''}`}
        onClick={() => void run()}
        title={armed ? 'Click again to confirm permanent delete' : `Delete connector "${connector.name}"`}
      >
        {busy ? 'Deleting…' : armed ? 'Confirm delete?' : 'Delete'}
      </button>
      {error && (
        <span className="rounded bg-error/10 px-2 py-1 text-[11px] text-error" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function ConnectorsTab({ canWrite }: { canWrite: boolean }) {
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [githubBanner, setGithubBanner] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const [githubConnecting, setGithubConnecting] = useState(false);
  const [githubSyncing, setGithubSyncing] = useState(false);
  const [githubRegistration, setGithubRegistration] = useState<
    | { state: 'loading' }
    | { state: 'unregistered' }
    | { state: 'registered'; slug: string; appId?: number; registeredAt?: string }
    | { state: 'error'; message: string }
  >({ state: 'loading' });
  const [githubRegistering, setGithubRegistering] = useState(false);
  const githubPopupPollRef = useRef<number | null>(null);

  // One-shot URL-param read on mount: surfaces the GitHub OAuth callback
  // outcome as a banner, then clears the param so a refresh doesn't repeat
  // the banner.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('github');
    if (!status) return;
    if (status === 'connected') {
      setGithubBanner({ kind: 'ok', message: 'GitHub connector created' });
      localStorage.setItem(GITHUB_CONNECT_EVENT_KEY, String(Date.now()));
    } else if (status === 'registered') {
      setGithubBanner({ kind: 'ok', message: 'Rounds GitHub App registered. You can now connect repos.' });
      localStorage.setItem(GITHUB_CONNECT_EVENT_KEY, String(Date.now()));
    } else if (status === 'error') {
      setGithubBanner({ kind: 'err', message: params.get('reason') ?? 'GitHub connection failed' });
    }
    params.delete('github');
    params.delete('reason');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
  }, []);
  const [formType, setFormType] = useState<ConnectorType>('prometheus');
  const [formName, setFormName] = useState('');
  const [formId, setFormId] = useState('');
  // Schema-driven config bag. Keys match the connector template's configSchema
  // properties; reconciled on type switch (see reconcileConfig).
  const [formConfig, setFormConfig] = useState<Record<string, unknown>>(() =>
    defaultsFor('prometheus'),
  );
  const [formIsDefault, setFormIsDefault] = useState(false);
  // Credentials section. `formSecret` covers single-field kinds (token,
  // kubeconfig, defensive default). For 'basic' we use the username/password
  // pair and combine into JSON at submit time. Sent via the separate
  // POST /connectors/:id/secret endpoint AFTER the connector is created.
  const [formSecret, setFormSecret] = useState('');
  const [formBasicUsername, setFormBasicUsername] = useState('');
  const [formBasicPassword, setFormBasicPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // When non-null, the form is in Edit mode for this connector id. Type is
  // locked, the ID field is hidden, and submit hits PUT /connectors/:id
  // (plus an optional POST /secret when the user typed new credentials).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activePoliciesConnector, setActivePoliciesConnector] = useState<ConnectorRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiClient.get<{ connectors: ConnectorRow[] }>('/connectors');
    if (res.error) {
      setError(res.error.message ?? 'Failed to load connectors');
      setConnectors([]);
    } else {
      setConnectors(res.data.connectors ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const syncGithubAndReload = useCallback(async (showEmpty = false) => {
    if (githubSyncing) return;
    setGithubSyncing(true);
    try {
      const res = await syncInstallations();
      if ('error' in res) {
        setGithubBanner({ kind: 'err', message: res.error });
        return;
      }
      const count = res.created.length + res.refreshed.length;
      if (count > 0) {
        setGithubBanner({
          kind: 'ok',
          message: res.created.length > 0
            ? `GitHub connector created for ${res.created.map((c) => c.owner).join(', ')}`
            : 'GitHub connector refreshed',
        });
      } else if (showEmpty) {
        setGithubBanner({ kind: 'err', message: 'No GitHub App installations found for this app yet.' });
      }
      await load();
    } finally {
      setGithubSyncing(false);
    }
  }, [githubSyncing, load]);

  const refreshGithubRegistration = useCallback(async () => {
    setGithubRegistration({ state: 'loading' });
    const res = await getRegistrationStatus();
    if ('error' in res) {
      setGithubRegistration({ state: 'error', message: res.error });
      return;
    }
    if (res.registered && res.slug) {
      setGithubRegistration({
        state: 'registered',
        slug: res.slug,
        ...(res.appId !== undefined ? { appId: res.appId } : {}),
        ...(res.registeredAt !== undefined ? { registeredAt: res.registeredAt } : {}),
      });
    } else {
      setGithubRegistration({ state: 'unregistered' });
    }
  }, []);

  // Refresh registration status when the GitHub form is opened, and on mount
  // so the "registered" banner from a fresh callback redirect reflects DB state.
  useEffect(() => { void refreshGithubRegistration(); }, [refreshGithubRegistration]);
  useEffect(() => {
    const refreshAfterGithubFlow = () => {
      void syncGithubAndReload(false);
      void refreshGithubRegistration();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === GITHUB_CONNECT_EVENT_KEY) refreshAfterGithubFlow();
    };
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') refreshAfterGithubFlow();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      if (githubPopupPollRef.current !== null) {
        window.clearInterval(githubPopupPollRef.current);
        githubPopupPollRef.current = null;
      }
    };
  }, [refreshGithubRegistration, syncGithubAndReload]);
  useEffect(() => {
    if (showForm && formType === 'github') void refreshGithubRegistration();
  }, [showForm, formType, refreshGithubRegistration]);

  const resetForm = () => {
    setFormType('prometheus');
    setFormName('');
    setFormId('');
    setFormConfig(defaultsFor('prometheus'));
    setFormIsDefault(false);
    setFormSecret('');
    setFormBasicUsername('');
    setFormBasicPassword('');
    setEditingId(null);
  };

  const credentialKind = getConnectorTemplate(formType).credential;

  /**
   * Switch the form into Edit mode for a given connector. Prefills the
   * type/name/config/isDefault from the listed row; leaves credentials
   * blank since secrets are write-only (user types new ones to rotate, or
   * leaves blank to keep what's stored).
   */
  const startEdit = (connector: ConnectorRow) => {
    setError(null);
    setEditingId(connector.id);
    setFormType(connector.type as ConnectorType);
    setFormName(connector.name);
    setFormId(connector.id);
    setFormConfig({ ...defaultsFor(connector.type as ConnectorType), ...(connector.config ?? {}) });
    setFormIsDefault(!!connector.isDefault);
    setFormSecret('');
    setFormBasicUsername('');
    setFormBasicPassword('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);

    if (editingId) {
      // Edit path: PUT /connectors/:id with the editable fields, then
      // (if user typed a new credential) POST /connectors/:id/secret to
      // rotate. Blank secret means "keep what's stored" — don't fire the
      // secret endpoint at all so an unrelated edit doesn't wipe the
      // existing kubeconfig/token.
      const patchRes = await apiClient.put<{ connector: { id: string } }>(
        `/connectors/${editingId}`,
        { name: formName, config: formConfig, isDefault: formIsDefault },
      );
      if (patchRes.error) {
        setSubmitting(false);
        setError(patchRes.error.message ?? 'Failed to update connector');
        return;
      }

      const secret = buildSecretValue(
        credentialKind,
        formSecret,
        formBasicUsername,
        formBasicPassword,
      );
      if (secret.kind === 'error') {
        setSubmitting(false);
        setError(secret.message);
        return;
      }
      if (secret.kind === 'send') {
        const secretRes = await apiClient.post(
          `/connectors/${editingId}/secret`,
          { secret: secret.value },
        );
        if (secretRes.error) {
          setSubmitting(false);
          setError(`Saved, but credential rotation failed: ${secretRes.error.message ?? 'unknown error'}`);
          await load();
          return;
        }
      }

      setSubmitting(false);
      setShowForm(false);
      resetForm();
      await load();
      return;
    }

    // Create path.
    const result = await submitConnectorWithSecret(apiClient, {
      type: formType,
      name: formName,
      config: formConfig,
      isDefault: formIsDefault,
      id: formId,
      credential: credentialKind,
      secret: formSecret,
      basicUsername: formBasicUsername,
      basicPassword: formBasicPassword,
    });
    setSubmitting(false);
    if (result.kind === 'validation-error' || result.kind === 'create-failed') {
      setError(result.message);
      return;
    }
    if (result.kind === 'secret-failed') {
      // Connector exists; keep the form closed but surface the failure inline
      // so the user knows to retry via Policies (per task spec).
      setError(
        `Connector created but secret upload failed: ${result.message}. Retry via Policies.`,
      );
      setShowForm(false);
      resetForm();
      await load();
      return;
    }
    setShowForm(false);
    resetForm();
    await load();
  };

  // Basic auth needs both fields filled or both blank — surfaced via the
  // submit button so the user sees the constraint without hitting submit.
  const basicIncomplete =
    (credentialKind as string) === 'basic' &&
    (!!formBasicUsername.trim() !== !!formBasicPassword);

  const submitEnabled =
    !submitting && !!formName && configIsValid(formType, formConfig) && !basicIncomplete;

  return (
    <div className="space-y-5">
      {githubBanner && githubBanner.kind === 'ok' && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 flex items-center justify-between gap-3">
          <span>{githubBanner.message}</span>
          <button type="button" className="text-xs underline" onClick={() => setGithubBanner(null)}>dismiss</button>
        </div>
      )}
      {githubBanner && githubBanner.kind === 'err' && (
        <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error flex items-center justify-between gap-3">
          <span>GitHub: {githubBanner.message}</span>
          <button type="button" className="text-xs underline" onClick={() => setGithubBanner(null)}>dismiss</button>
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--color-on-surface)]">
            {loading ? 'Loading connectors...' : `${connectors.length} connector${connectors.length === 1 ? '' : 's'} configured`}
          </p>
          <p className="text-xs text-[var(--color-on-surface-variant)] mt-1">
            Observability, runtime, code, incident, notification, and cloud connectors share one model.
          </p>
        </div>
        <button
          type="button"
          disabled={!canWrite}
          className={btnPrimary}
          onClick={() => { setError(null); if (showForm) resetForm(); setShowForm((v) => !v); }}
        >
          {showForm ? 'Cancel' : 'Add Connector'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); void handleSave(); }}
          className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface)] p-4 space-y-3"
        >
          {editingId && (
            <div className="rounded border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)]/40 p-3 text-xs text-[var(--color-on-surface-variant)]">
              Editing <span className="font-mono text-[var(--color-on-surface)]">{editingId}</span>. Type can't be changed once a connector exists. Leave credential fields blank to keep the existing secret.
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Type</label>
            <select
              value={formType}
              disabled={!!editingId}
              onChange={(e) => {
                const next = e.target.value as ConnectorType;
                setFormConfig((prev) => reconcileConfig(prev, next));
                setFormType(next);
                // Clear credentials on type switch — credential KIND changes
                // (token → kubeconfig) and stale state from the prior type
                // would silently end up in the wrong field on submit.
                setFormSecret('');
                setFormBasicUsername('');
                setFormBasicPassword('');
              }}
              className={selectCls}
            >
              {CONNECTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Name</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Prod Prometheus"
              className={inputCls}
              required
            />
          </div>
          {!editingId && (
            <div>
              <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">ID (optional)</label>
              <input
                type="text"
                value={formId}
                onChange={(e) => setFormId(e.target.value)}
                placeholder="auto-generated if blank"
                className={inputCls}
              />
            </div>
          )}
          {formType === 'github' ? (
            <div className="rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)]/40 p-4 space-y-3">
              {githubRegistration.state === 'loading' && (
                <p className="text-xs text-[var(--color-on-surface-variant)]">Checking GitHub App registration…</p>
              )}
              {githubRegistration.state === 'error' && (
                <p className="text-xs text-error">{githubRegistration.message}</p>
              )}
              {githubRegistration.state === 'unregistered' && (
                <>
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    GitHub integration requires a one-time setup. Click below to create a "Rounds" GitHub App on your account — takes 5 seconds.
                  </div>
                  <button
                    type="button"
                    disabled={githubRegistering}
                    className={btnPrimary}
                    onClick={async () => {
                      setGithubRegistering(true);
                      setError(null);
                      const res = await getManifest();
                      setGithubRegistering(false);
                      if ('error' in res) {
                        setError(res.error);
                        return;
                      }
                      const out = submitManifestForm(res);
                      if (!out.ok && out.reason === 'popup-blocked') {
                        setError('Browser blocked the popup. Allow popups for this site and click Register again.');
                      }
                    }}
                  >
                    {githubRegistering ? 'Preparing…' : 'Register Rounds GitHub App'}
                  </button>
                </>
              )}
              {githubRegistration.state === 'registered' && (
                <>
                  <p className="text-xs text-[var(--color-on-surface-variant)]">
                    Authorize the Rounds GitHub App on your org. Repos you select become accessible to investigations and remediation plans.
                  </p>
                  <button
                    type="button"
                    disabled={githubConnecting}
                    className={btnPrimary}
                    onClick={async () => {
                      setGithubConnecting(true);
                      setError(null);
                      const res = await apiClient.get<{ url: string }>('/connectors/github/install-url');
                      setGithubConnecting(false);
                      if (res.error) {
                        setError(res.error.message ?? 'GitHub App is not registered.');
                        return;
                      }
                      // Open in a new tab. Don't fall back to same-tab on
                      // popup-block — that yanks the operator out of Settings.
                      // Tell them to unblock popups instead.
                      // 'noopener' so the new tab can't navigate back to here.
                      const popup = window.open(res.data.url, '_blank', 'noopener');
                      if (!popup) {
                        setError('Browser blocked the popup. Allow popups for this site and click Connect to GitHub again.');
                        return;
                      }
                      if (githubPopupPollRef.current !== null) {
                        window.clearInterval(githubPopupPollRef.current);
                      }
                      githubPopupPollRef.current = window.setInterval(() => {
                        if (!popup.closed) return;
                        if (githubPopupPollRef.current !== null) {
                          window.clearInterval(githubPopupPollRef.current);
                          githubPopupPollRef.current = null;
                        }
                        void syncGithubAndReload(false);
                        void refreshGithubRegistration();
                      }, 1000);
                    }}
                  >
                    {githubConnecting ? 'Opening…' : 'Connect to GitHub'}
                  </button>
                  <button
                    type="button"
                    disabled={githubSyncing}
                    className={btnSecondary}
                    onClick={() => void syncGithubAndReload(true)}
                  >
                    {githubSyncing ? 'Syncing...' : 'Sync installed app'}
                  </button>
                  <div className="flex items-center gap-2 text-[11px] text-[var(--color-on-surface-variant)]">
                    <span>
                      Rounds GitHub App: '{githubRegistration.slug}'
                      {githubRegistration.registeredAt
                        ? ` (registered ${githubRegistration.registeredAt})`
                        : ''}
                    </span>
                    <button
                      type="button"
                      className="underline"
                      onClick={async () => {
                        const r = await unregisterGithubApp();
                        if ('error' in r) {
                          setError(r.error);
                          return;
                        }
                        await refreshGithubRegistration();
                      }}
                    >
                      Re-register
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <ConnectorConfigFields
                type={formType}
                config={formConfig}
                onChange={setFormConfig}
              />
              <CredentialsSection
                kind={credentialKind}
                secret={formSecret}
                onSecretChange={setFormSecret}
                basicUsername={formBasicUsername}
                onBasicUsernameChange={setFormBasicUsername}
                basicPassword={formBasicPassword}
                onBasicPasswordChange={setFormBasicPassword}
              />
            </>
          )}
          {formType !== 'github' && (
            <label className="flex items-center gap-2 text-sm text-[var(--color-on-surface)]">
              <input type="checkbox" checked={formIsDefault} onChange={(e) => setFormIsDefault(e.target.checked)} />
              Set as default for this type
            </label>
          )}
          {formType !== 'github' && (
            <p className="text-xs text-[var(--color-on-surface-variant)]">
              Advanced config (auth headers, TLS, etc.): edit via Policies after creation.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              className={btnSecondary}
              disabled={submitting}
            >
              Cancel
            </button>
            {formType !== 'github' && (
              <button type="submit" className={btnPrimary} disabled={!submitEnabled}>
                {submitting
                  ? (editingId ? 'Saving...' : 'Creating...')
                  : (editingId ? 'Save changes' : 'Create')}
              </button>
            )}
          </div>
        </form>
      )}

      {!loading && connectors.length === 0 && !error && !showForm && (
        <div className="rounded-lg border border-dashed border-[var(--color-outline-variant)] p-6 text-sm text-[var(--color-on-surface-variant)]">
          No connectors yet.
        </div>
      )}

      <div className="space-y-2">
        {connectors.map((connector) => (
          <div key={connector.id} className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface)] p-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-[var(--color-on-surface)]">{connector.name}</h3>
                  <span className="rounded border border-[var(--color-outline-variant)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)]">
                    {connector.type}
                  </span>
                  <span className="rounded border border-[var(--color-outline-variant)] px-1.5 py-0.5 text-[10px] text-[var(--color-on-surface-variant)]">
                    {connector.status}
                  </span>
                </div>
                <p className="mt-2 text-xs text-[var(--color-on-surface-variant)] break-words">
                  {(connector.capabilities ?? []).join(', ') || 'No capabilities reported'}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-start justify-end gap-2 md:flex-nowrap">
                <TestConnectorButton connector={connector} disabled={!canWrite} />
                {/* Edit goes through the same form as Create. GitHub
                    connectors are special: their form is an OAuth flow,
                    not a credential-paste form, so editing here would do
                    nothing useful — disconnect + reconnect instead. */}
                {connector.type !== 'github' && (
                  <button
                    type="button"
                    disabled={!canWrite}
                    className={btnSecondary}
                    onClick={() => startEdit(connector)}
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canWrite}
                  className={btnSecondary}
                  onClick={() => setActivePoliciesConnector(connector)}
                >
                  Policies
                </button>
                <DeleteConnectorButton
                  connector={connector}
                  disabled={!canWrite}
                  onDeleted={() => void load()}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {activePoliciesConnector && (
        <ConnectorPoliciesDialog
          connector={{
            id: activePoliciesConnector.id,
            name: activePoliciesConnector.name,
            type: activePoliciesConnector.type,
          }}
          onClose={() => setActivePoliciesConnector(null)}
        />
      )}
    </div>
  );
}

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

      {/* Right content area */}
      <div className="flex-1 overflow-y-auto py-6 px-8">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-[var(--color-on-surface)] mb-1">
            {TABS.find((t) => t.id === tab)?.label}
          </h2>
          <p className="text-sm text-[var(--color-on-surface-variant)] mb-6">
            {tab === 'connectors' && 'Manage unified connectors and capability policies.'}
            {tab === 'ai' && 'Configure the AI model used for investigations and analysis.'}
            {tab === 'notifications' && 'Set up alert delivery channels.'}
            {tab === 'account' && 'Review your account details.'}
            {tab === 'danger' && 'Irreversible actions for your Rounds instance.'}
          </p>

          {tab === 'connectors' && <ConnectorsTab canWrite={canWriteConnectors} />}
          {tab === 'ai' && <LlmTab canWrite={canAdminWrite} />}
          {tab === 'notifications' && <NotificationsTab canWrite={canAdminWrite} />}
          {tab === 'account' && <AccountTab />}
          {tab === 'danger' && <DangerTab canReset={canAdminWrite} />}
        </div>
      </div>
    </div>
  );
}
