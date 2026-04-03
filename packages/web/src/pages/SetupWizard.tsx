import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';

// Types

type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'azure-openai'
  | 'aws-bedrock'
  | 'ollama'
  | 'corporate-gateway';

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  region: string;
  authType: string;
  tokenHelperCommand: string;
}

interface DatasourceEntry {
  type: string;
  name: string;
  url: string;
  apiKey: string;
}

interface NotificationConfig {
  slackWebhook: string;
  pagerDutyKey: string;
  emailHost: string;
  emailPort: string;
  emailUser: string;
  emailPass: string;
  emailFrom: string;
}

// Provider metadata

const LLM_PROVIDERS: Array<{
  value: LlmProvider;
  label: string;
  fallbackModels: string[];
  needsKey: boolean;
  needsUrl?: boolean;
  needsRegion?: boolean;
  supportsModelFetch?: boolean;
}> = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    fallbackModels: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'openai',
    label: 'OpenAI',
    fallbackModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    fallbackModels: ['gpt-4o', 'gpt-4-turbo'],
    needsKey: true,
    needsUrl: true,
  },
  {
    value: 'aws-bedrock',
    label: 'AWS Bedrock',
    fallbackModels: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'amazon.nova-pro-v1:0'],
    needsKey: false,
    needsRegion: true,
  },
  {
    value: 'ollama',
    label: 'Local (Ollama / Llama)',
    fallbackModels: ['llama3.2', 'mistral', 'gemma2'],
    needsKey: false,
    needsUrl: true,
    supportsModelFetch: true,
  },
  {
    value: 'corporate-gateway',
    label: 'Corporate Gateway (Okta/SSO)',
    fallbackModels: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    needsKey: false,
    needsUrl: true,
  },
];

const DATASOURCE_TYPES = [
  { value: 'loki', label: 'Loki', category: 'Logs' },
  { value: 'elasticsearch', label: 'Elasticsearch', category: 'Logs' },
  { value: 'clickhouse', label: 'ClickHouse', category: 'Logs' },
  { value: 'tempo', label: 'Tempo', category: 'Traces' },
  { value: 'jaeger', label: 'Jaeger', category: 'Traces' },
  { value: 'otel', label: 'OTel Collector', category: 'Traces' },
  { value: 'prometheus', label: 'Prometheus', category: 'Metrics' },
  { value: 'victoria-metrics', label: 'VictoriaMetrics', category: 'Metrics' },
];

// Step progress bar

const STEPS = ['Welcome', 'LLM Provider', 'Data Sources', 'Notifications', 'Ready'];

function ProgressBar({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-4 mb-10">
      {STEPS.map((label, i) => (
        <React.Fragment key={label}>
          <div className="flex flex-col items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i === current
                  ? 'bg-[#6366F1] text-white ring-4 ring-[#6366F1]/20'
                  : i < current
                    ? 'bg-[#6366F1] text-white'
                    : 'bg-[#2A2A3E] text-[#8888AA]'
              }`}
            >
              {i + 1}
            </div>
            <span
              className={`mt-1.5 text-xs font-medium hidden sm:block ${
                i === current ? 'text-[#6366F1]' : 'text-[#8888AA]'
              }`}
            >
              {label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`flex-1 h-0.5 mt-[-16px] ${i < current ? 'bg-[#6366F1]' : 'bg-[#2A2A3E]'}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// Step 1: Welcome

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center py-8">
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-indigo-600 text-white text-4xl mb-6">
        <span role="img" aria-label="radar">
          AI
        </span>
      </div>
      <h1 className="text-3xl font-bold text-[#E8E8ED] mb-2">Welcome to AgentObs</h1>
      <p className="text-lg text-[#8888AA] font-medium mb-2">AI-native observability platform</p>
      <p className="text-[#8888AA] max-w-2xl mx-auto mb-10">
        Automatically investigate incidents, correlate signals, and generate runbooks, powered by LLMs.
      </p>
      <p className="text-sm text-[#8888AA] mb-10">Let's get you set up in 2 minutes.</p>
      <button
        type="button"
        onClick={onNext}
        className="px-8 py-3 rounded-xl bg-indigo-600 text-white font-semibold text-base hover:bg-indigo-700 transition-colors shadow-md"
      >
        Get Started →
      </button>
    </div>
  );
}

// Step 2: LLM Provider

function StepLlm({
  config,
  onChange,
  onNext,
  onBack,
}: {
  config: LlmConfig;
  onChange: (c: Partial<LlmConfig>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const provider = LLM_PROVIDERS.find((p) => p.value === config.provider) ?? LLM_PROVIDERS[0]!;

  // The models to show: remote if fetched, otherwise fallback
  const availableModels: Array<{ id: string; label: string }> = remoteModels.length > 0
    ? remoteModels.map((m) => ({ id: m.id, label: m.description ? `${m.name} (${m.description})` : m.name }))
    : provider.fallbackModels.map((m) => ({ id: m, label: m }));

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setRemoteModels([]);
    setModelsFetched(false);
    const res = await apiClient.post<{ models: ModelInfo[] }>('/setup/llm/models', {
      provider: config.provider,
      apiKey: config.apiKey || undefined,
      baseUrl: config.baseUrl || undefined,
    });
    setFetchingModels(false);
    setModelsFetched(true);
    if (res.data?.models && res.data.models.length > 0) {
      setRemoteModels(res.data.models);
      // Auto-select first model if current selection not in list
      const ids = res.data.models.map((m) => m.id);
      if (!ids.includes(config.model)) {
        onChange({ model: res.data.models[0]!.id });
      }
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/llm/test', {
      provider: config.provider,
      apiKey: config.apiKey || undefined,
      model: config.model,
      baseUrl: config.baseUrl || undefined,
      region: config.region || undefined,
      authType: config.authType || undefined,
      tokenHelperCommand: config.tokenHelperCommand || undefined,
    });
    setTesting(false);
    if (res.error) {
      setTestResult({ ok: false, message: res.error.message });
    } else {
      setTestResult(res.data);
    }
  };

  const handleNext = async () => {
    await apiClient.post('/setup/llm', {
      config: {
        provider: config.provider,
        apiKey: config.apiKey || undefined,
        model: config.model,
        baseUrl: config.baseUrl || undefined,
        region: config.region || undefined,
        authType: config.authType || undefined,
        tokenHelperCommand: config.tokenHelperCommand || undefined,
      },
    });
    onNext();
  };

  const canProceed =
    config.model &&
    (config.provider === 'corporate-gateway' ||
      !provider.needsKey ||
      config.apiKey.length > 0);

  return (
    <div>
      <h2 className="text-xl font-bold text-[#E8E8ED] mb-1">LLM Provider</h2>
      <p className="text-[#8888AA] text-sm mb-6">Choose the AI model that powers your investigations.</p>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">Providers</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {LLM_PROVIDERS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  onChange({
                    provider: p.value,
                    model: p.fallbackModels[0],
                    apiKey: '',
                    baseUrl: '',
                    region: '',
                    authType: p.value === 'corporate-gateway' ? 'bearer' : 'api-key',
                    tokenHelperCommand: '',
                  });
                  setTestResult(null);
                  setRemoteModels([]);
                  setModelsFetched(false);
                }}
                className={`text-left px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors ${
                  config.provider === p.value
                    ? 'border-[#6366F1] bg-[#1C1C2E] text-[#6366F1]'
                    : 'border-[#2A2A3E] text-[#8888AA] hover:border-[#4F46E5] hover:bg-[#1C1C2E]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {provider.needsKey && (
          <div>
            <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">API Key</label>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => {
                onChange({ apiKey: e.target.value });
                setTestResult(null);
              }}
              placeholder="sk-..."
              className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
          </div>
        )}

        {provider.needsUrl && (
          <div>
            <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">
              {config.provider === 'ollama' ? 'Ollama URL' : 'Endpoint URL'}
            </label>
            <input
              type="url"
              value={config.baseUrl}
              onChange={(e) => {
                onChange({ baseUrl: e.target.value });
                setTestResult(null);
              }}
              placeholder={config.provider === 'ollama' ? 'http://localhost:11434' : 'https://your-resource.openai.azure.com'}
              className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
          </div>
        )}

        {config.provider === 'corporate-gateway' && (
          <div>
            <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">
              Token Helper Command
            </label>
            <input
              type="text"
              value={config.tokenHelperCommand}
              onChange={(e) => {
                onChange({ tokenHelperCommand: e.target.value });
                setTestResult(null);
              }}
              placeholder="./scripts/token.sh"
              className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1] font-mono"
            />
            <p className="text-xs text-[#8888AA] mt-1">
              Shell command that outputs an auth token. Token is cached and refreshed automatically.
            </p>
          </div>
        )}

        {provider.needsRegion && (
          <div>
            <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">AWS Region</label>
            <input
              type="text"
              value={config.region}
              onChange={(e) => {
                onChange({ region: e.target.value });
                setTestResult(null);
              }}
              placeholder="us-east-1"
              className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">Default Model</label>
          <div className="flex gap-2">
            <select
              value={config.model}
              onChange={(e) => onChange({ model: e.target.value })}
              className="flex-1 px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {provider.supportsModelFetch && (
              <button
                type="button"
                onClick={() => void handleFetchModels()}
                disabled={fetchingModels || (provider.needsKey && !config.apiKey)}
                className="px-3 py-2 rounded-lg border border-[#2A2A3E] text-sm font-medium text-[#E8E8ED] hover:bg-[#1C1C2E] disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {fetchingModels ? 'Loading...' : 'Fetch Models'}
              </button>
            )}
          </div>
          {modelsFetched && remoteModels.length === 0 && (
            <p className="text-xs text-amber-400 mt-1">
              Could not fetch models. Check your API key / URL and try again.
            </p>
          )}
          {remoteModels.length > 0 && (
            <p className="text-xs text-emerald-400 mt-1">
              Found {remoteModels.length} models from provider
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing || !canProceed}
            className="px-4 py-2 rounded-lg border border-[#2A2A3E] text-sm font-medium text-[#E8E8ED] hover:bg-[#1C1C2E] disabled:opacity-50 transition-colors"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testResult && (
            <span className={`text-sm font-medium ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.ok ? '✓ ' : '✗ '}
              {testResult.message}
            </span>
          )}
        </div>

        <div className="flex justify-between mt-8">
          <button type="button" onClick={onBack} className="px-5 py-2 text-sm font-medium text-[#8888AA] hover:text-[#E8E8ED]">
            ← Back
          </button>
          <button
            type="button"
            onClick={() => void handleNext()}
            disabled={!canProceed}
            className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// Step 3: Data Sources

function StepDatasources({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [entries, setEntries] = useState<DatasourceEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<DatasourceEntry>({ type: 'loki', name: '', url: '', apiKey: '' });
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!form.url) return;
    setSaving(true);
    await apiClient.post('/setup/datasource', {
      datasource: {
        ...form,
        id: `${Date.now()}`,
        name: form.name || form.type,
      },
    });
    setEntries((prev) => [...prev, form]);
    setForm({ type: 'loki', name: '', url: '', apiKey: '' });
    setAdding(false);
    setSaving(false);
  };

  const handleTest = async (idx: number) => {
    const ds = entries[idx];
    const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/datasource', {
      datasource: ds,
      test: true,
    });
    setTestResults((prev) => ({
      ...prev,
      [idx]: res.error ? { ok: false, message: res.error.message } : res.data,
    }));
  };

  const categories = ['Logs', 'Traces', 'Metrics'];

  return (
    <div>
      <h2 className="text-xl font-bold text-[#E8E8ED] mb-1">Data Sources</h2>
      <p className="text-[#8888AA] text-sm mb-6">Connect your observability backends. You can add more later in Settings.</p>

      {entries.length > 0 && (
        <div className="space-y-2 mb-4">
          {entries.map((ds, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[#1C1C2E] border border-[#2A2A3E]">
              <span className="text-xs font-mono bg-[#0A0A0F] border border-[#2A2A3E] rounded px-2 py-1 text-[#8888AA]">
                {ds.type}
              </span>
              <span className="text-sm text-[#E8E8ED] flex-1">
                {ds.name || ds.url}
              </span>
              <button
                type="button"
                onClick={() => void handleTest(i)}
                className="text-xs text-[#6366F1] hover:text-[#818CF8] font-medium"
              >
                Test
              </button>
              {testResults[i] && (
                <span className={`text-xs font-medium ${testResults[i].ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResults[i].ok ? '✓ ' : '✗ '}
                  {testResults[i].message}
                </span>
              )}
              <button
                type="button"
                onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
                className="text-xs text-[#8888AA] hover:text-[#E8E8ED]"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="border border-[#2A2A3E] rounded-xl bg-[#141420] p-4 space-y-3 mb-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              >
                {categories.map((cat) => (
                  <optgroup key={cat} label={cat}>
                    {DATASOURCE_TYPES.filter((d) => d.category === cat).map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">Name (optional)</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="prod-loki"
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">URL</label>
              <input
                type="url"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="http://localhost:3100"
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">API Key (optional)</label>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="password"
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={!form.url || saving}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40"
            >
              {saving ? 'Adding...' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-4 py-2 text-sm text-[#8888AA] hover:text-[#E8E8ED]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdding(true)}
        className="w-full py-3 rounded-xl border-2 border-dashed border-[#2A2A3E] text-sm text-[#8888AA] hover:border-[#6366F1] hover:text-[#6366F1] transition-colors mb-4"
      >
        + Add data source
      </button>

      <div className="flex justify-between mt-6">
        <button type="button" onClick={onBack} className="px-5 py-2 text-sm font-medium text-[#8888AA] hover:text-[#E8E8ED]">
          ← Back
        </button>
        <div className="flex gap-3">
          <button type="button" onClick={onNext} className="px-5 py-2 text-sm text-[#8888AA] hover:text-[#E8E8ED]">
            Skip for now
          </button>
          <button
            type="button"
            onClick={onNext}
            className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

// Step 4: Notifications

function StepNotifications({
  config,
  onChange,
  onNext,
  onBack,
}: {
  config: NotificationConfig;
  onChange: (c: Partial<NotificationConfig>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const handleNext = async () => {
    setSaving(true);
    const notifications: Record<string, unknown> = {};
    if (config.slackWebhook) notifications['slack'] = { webhookUrl: config.slackWebhook };
    if (config.pagerDutyKey) notifications['pagerduty'] = { integrationKey: config.pagerDutyKey };
    if (config.emailHost) {
      notifications['email'] = {
        host: config.emailHost,
        port: Number.parseInt(config.emailPort || '587', 10),
        username: config.emailUser,
        password: config.emailPass,
        from: config.emailFrom,
      };
    }

    if (Object.keys(notifications).length > 0) {
      await apiClient.post('/setup/notifications', { notifications });
    }
    setSaving(false);
    onNext();
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-[#E8E8ED] mb-1">Notifications</h2>
      <p className="text-[#8888AA] text-sm mb-6">
        Get alerted when incidents are detected. All optional - skip if not needed now.
      </p>

      <div className="space-y-4">
        <div className="p-4 rounded-xl border border-[#2A2A3E] bg-[#141420]">
          <h3 className="text-sm font-semibold text-[#E8E8ED] mb-3">Slack</h3>
          <label className="block text-xs font-medium text-[#8888AA] mb-1">Webhook URL</label>
          <input
            type="url"
            value={config.slackWebhook}
            onChange={(e) => onChange({ slackWebhook: e.target.value })}
            placeholder="https://hooks.slack.com/services/..."
            className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
          />
        </div>

        <div className="p-4 rounded-xl border border-[#2A2A3E] bg-[#141420]">
          <h3 className="text-sm font-semibold text-[#E8E8ED] mb-3">PagerDuty</h3>
          <label className="block text-xs font-medium text-[#8888AA] mb-1">Integration Key</label>
          <input
            type="password"
            value={config.pagerDutyKey}
            onChange={(e) => onChange({ pagerDutyKey: e.target.value })}
            placeholder="your-integration-key"
            className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
          />
        </div>

        <div className="p-4 rounded-xl border border-[#2A2A3E] bg-[#141420]">
          <h3 className="text-sm font-semibold text-[#E8E8ED] mb-3">Email (SMTP)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">SMTP Host</label>
              <input
                type="text"
                value={config.emailHost}
                onChange={(e) => onChange({ emailHost: e.target.value })}
                placeholder="smtp.example.com"
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">Port</label>
              <input
                type="number"
                value={config.emailPort}
                onChange={(e) => onChange({ emailPort: e.target.value })}
                placeholder="587"
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">Username</label>
              <input
                type="text"
                value={config.emailUser}
                onChange={(e) => onChange({ emailUser: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#8888AA] mb-1">Password</label>
              <input
                type="text"
                value={config.emailPass}
                onChange={(e) => onChange({ emailPass: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[#8888AA] mb-1">From address</label>
              <input
                type="email"
                value={config.emailFrom}
                onChange={(e) => onChange({ emailFrom: e.target.value })}
                placeholder="alerts@example.com"
                className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-between mt-6">
          <button type="button" onClick={onBack} className="px-5 py-2 text-sm font-medium text-[#8888AA] hover:text-[#E8E8ED]">
            ← Back
          </button>
          <div className="flex gap-3">
            <button type="button" onClick={onNext} className="px-5 py-2 text-sm text-[#8888AA] hover:text-[#E8E8ED]">
              Skip for now
            </button>
            <button
              type="button"
              onClick={() => void handleNext()}
              disabled={saving}
              className="px-6 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Step 5: Ready

function StepReady({
  llm,
  onFinish,
}: {
  llm: LlmConfig;
  onFinish: () => void;
}) {
  const [completing, setCompleting] = useState(false);

  const handleFinish = async () => {
    setCompleting(true);
    await apiClient.post('/setup/complete', {});
    setCompleting(false);
    onFinish();
  };

  const providerLabel = LLM_PROVIDERS.find((p) => p.value === llm.provider)?.label ?? llm.provider;

  return (
    <div className="text-center py-8">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 text-3xl mb-6">
        ✓
      </div>
      <h2 className="text-2xl font-bold text-[#E8E8ED] mb-2">You're all set!</h2>
      <p className="text-[#8888AA] mb-8">AgentObs is configured and ready to investigate.</p>

      <div className="text-left bg-[#1C1C2E] rounded-xl border border-[#2A2A3E] p-4 mb-8 max-w-md mx-auto space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-[#8888AA]">LLM Provider</span>
          <span className="font-medium text-[#E8E8ED]">{providerLabel}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#8888AA]">Model</span>
          <span className="font-medium text-[#E8E8ED]">{llm.model}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleFinish()}
        disabled={completing}
        className="px-8 py-3 rounded-xl bg-indigo-600 text-white font-semibold text-base hover:bg-indigo-700 disabled:opacity-40 transition-colors shadow-md"
      >
        {completing ? 'Starting...' : 'Start Investigating →'}
      </button>
    </div>
  );
}

// Main SetupWizard component

export default function SetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  const [llm, setLlm] = useState<LlmConfig>({
    provider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-5',
    baseUrl: '',
    region: '',
    authType: 'api-key',
    tokenHelperCommand: '',
  });

  const [notifications, setNotifications] = useState<NotificationConfig>({
    slackWebhook: '',
    pagerDutyKey: '',
    emailHost: '',
    emailPort: '587',
    emailUser: '',
    emailPass: '',
    emailFrom: '',
  });

  const next = () => setStep((s) => s + 1);
  const back = () => setStep((s) => s - 1);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl bg-[#141420] border border-[#2A2A3E] rounded-2xl p-8">
        <ProgressBar current={step} />

        {step === 0 && <StepWelcome onNext={next} />}
        {step === 1 && (
          <StepLlm
            config={llm}
            onChange={(c) => setLlm((prev) => ({ ...prev, ...c }))}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 2 && <StepDatasources onNext={next} onBack={back} />}
        {step === 3 && (
          <StepNotifications
            config={notifications}
            onChange={(c) => setNotifications((prev) => ({ ...prev, ...c }))}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 4 && (
          <StepReady
            llm={llm}
            onFinish={() => navigate('/')}
          />
        )}
      </div>
    </div>
  );
}
