import React, { useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';

// Types

type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'azure-openai' | 'aws-bedrock' | 'ollama';

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
}

interface SetupStatus {
  configured: boolean;
  hasLlm: boolean;
  datasourceCount: number;
  hasNotifications: boolean;
}

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
    fallbackModels: ['anthropic.claude-3-sonnet', 'mistral'],
    needsKey: false,
    needsRegion: true,
  },
  {
    value: 'ollama',
    label: 'Local (Ollama / Llama)',
    fallbackModels: ['llama3.2', 'mistral', 'qwen2.5'],
    needsKey: false,
    needsUrl: true,
    supportsModelFetch: true,
  },
];

// Section card

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-[#141420] rounded-xl border border-[#2A2A3E] p-6">
      <h2 className="text-base font-semibold text-[#E8E8ED] mb-4">{title}</h2>
      {children}
    </section>
  );
}

// LLM Section

function LlmSection() {
  const [config, setConfig] = useState<LlmConfig>({
    provider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-5',
    baseUrl: '',
    region: '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const provider = LLM_PROVIDERS.find((p) => p.value === config.provider) ?? LLM_PROVIDERS[0]!;

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
      const ids = res.data.models.map((m) => m.id);
      if (!ids.includes(config.model)) {
        setConfig((prev) => ({ ...prev, model: res.data!.models[0]!.id }));
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    await apiClient.post('/setup/llm', {
      config: {
        provider: config.provider,
        apiKey: config.apiKey || undefined,
        model: config.model,
        baseUrl: config.baseUrl || undefined,
        region: config.region || undefined,
      },
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/llm/test', {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      region: config.region,
    });
    setTesting(false);
    setTestResult(res.error ? { ok: false, message: res.error.message } : res.data);
  };

  return (
    <Section title="LLM Provider">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">Provider</label>
          <select
            value={config.provider}
            onChange={(e) => {
              const p = e.target.value as LlmProvider;
              const pm = LLM_PROVIDERS.find((x) => x.value === p);
              setConfig((prev) => ({
                ...prev,
                provider: p,
                model: pm?.fallbackModels[0] ?? '',
                apiKey: '',
                baseUrl: '',
                region: '',
              }));
              setTestResult(null);
              setRemoteModels([]);
              setModelsFetched(false);
            }}
            className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
          >
            {LLM_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {provider.needsKey && (
          <div>
            <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">API Key</label>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => {
                setConfig((prev) => ({ ...prev, apiKey: e.target.value }));
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
              type="text"
              value={config.baseUrl}
              onChange={(e) => setConfig((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder={config.provider === 'ollama' ? 'http://localhost:11434' : 'https://your-resource.openai.azure.com'}
              className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
          </div>
        )}

        {provider.needsRegion && (
          <div>
            <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">AWS Region</label>
            <input
              type="text"
              value={config.region}
              onChange={(e) => setConfig((prev) => ({ ...prev, region: e.target.value }))}
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
              onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
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

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className="px-3 py-2 rounded-lg border border-[#2A2A3E] text-sm font-medium text-[#E8E8ED] hover:bg-[#1C1C2E] disabled:opacity-50"
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

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="ml-auto px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40"
        >
          {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
    </Section>
  );
}

// Notifications Section

function NotificationsSection() {
  const [slackWebhook, setSlackWebhook] = useState('');
  const [pagerDutyKey, setPagerDutyKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const notifications: Record<string, unknown> = {};
    if (slackWebhook) notifications['slack'] = { webhookUrl: slackWebhook };
    if (pagerDutyKey) notifications['pagerduty'] = { integrationKey: pagerDutyKey };
    await apiClient.post('/setup/notifications', { notifications });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Section title="Notifications">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">Slack Webhook URL</label>
          <input
            type="url"
            value={slackWebhook}
            onChange={(e) => setSlackWebhook(e.target.value)}
            placeholder="https://hooks.slack.com/services/..."
            className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">PagerDuty Integration Key</label>
          <input
            type="password"
            value={pagerDutyKey}
            onChange={(e) => setPagerDutyKey(e.target.value)}
            placeholder="your-integration-key"
            className="w-full px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40"
          >
            {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </Section>
  );
}

// Danger Zone

function DangerZone() {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const handleReset = async () => {
    await apiClient.post('/setup/reset', {});
    setDone(true);
    setConfirming(false);
    window.location.href = '/setup';
  };

  return (
    <Section title="Danger Zone">
      <p className="text-sm text-[#8888AA] mb-4">
        Reset all configuration and return to the setup wizard. This cannot be undone.
      </p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="px-4 py-2 rounded-lg border border-red-500/50 text-red-400 text-sm font-medium hover:bg-red-500/20"
        >
          Reset Configuration
        </button>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#E8E8ED]">Are you sure?</span>
          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={done}
            className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-40"
          >
            Yes, Reset
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-4 py-2 text-sm text-[#8888AA] hover:text-[#E8E8ED]"
          >
            Cancel
          </button>
        </div>
      )}
    </Section>
  );
}

// Main Settings page

export default function Settings() {
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    void apiClient.get<SetupStatus>('/setup/status').then((res) => {
      if (!res.error) setStatus(res.data);
    });
  }, []);

  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-[#E8E8ED] mb-1">Settings</h1>
          <p className="text-[#8888AA] text-sm">Configure your AgentObs platform.</p>
          {status && (
            <div className="mt-3 flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${
                  status.configured
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-amber-500/20 text-amber-400'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    status.configured ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                {status.configured ? 'Configured' : 'Setup Incomplete'}
              </span>
            </div>
          )}
        </div>

        <LlmSection />
        <div className="h-6" />
        <NotificationsSection />
        <div className="h-6" />
        <DangerZone />
      </div>
    </div>
  );
}
