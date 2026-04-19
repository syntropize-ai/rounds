import React, { useState } from 'react';
import { apiClient } from '../../api/client.js';
import { llmBaseUrlPlaceholder } from '../../constants/placeholders.js';
import { LLM_PROVIDERS } from './types.js';
import type { LlmConfig, ModelInfo } from './types.js';

export function StepLlm({
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
  const [modelsWarning, setModelsWarning] = useState<string | null>(null);

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
    setModelsWarning(null);
    try {
      const res = await apiClient.post<{ models: ModelInfo[]; warning?: string }>(
        '/setup/llm/models',
        {
          provider: config.provider,
          apiKey: config.apiKey || undefined,
          baseUrl: config.baseUrl || undefined,
        },
      );
      if (res.data?.models && res.data.models.length > 0) {
        setRemoteModels(res.data.models);
        // Auto-select first model if current selection not in list
        const ids = res.data.models.map((m) => m.id);
        if (!ids.includes(config.model)) {
          onChange({ model: res.data.models[0]!.id });
        }
      }
      if (res.data?.warning) setModelsWarning(res.data.warning);
      if (res.error) setModelsWarning(res.error.message ?? 'Failed to fetch models');
    } catch (err) {
      // Network / client-side failures still need to clear the loading state.
      setModelsWarning(err instanceof Error ? err.message : 'Failed to fetch models');
    } finally {
      setFetchingModels(false);
      setModelsFetched(true);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiClient.post<{ ok: boolean; message: string }>('/setup/llm/test', {
        provider: config.provider,
        apiKey: config.apiKey || undefined,
        model: config.model,
        baseUrl: config.baseUrl || undefined,
        region: config.region || undefined,
        authType: config.authType || undefined,
      });
      if (res.error) {
        setTestResult({ ok: false, message: res.error.message });
      } else {
        setTestResult(res.data);
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleNext = async () => {
    // PUT /api/system/llm is the authed save endpoint. The bootstrap-aware
    // middleware on the server lets the wizard reach it without auth until
    // the first admin is created.
    await apiClient.put('/system/llm', {
      provider: config.provider,
      apiKey: config.apiKey || undefined,
      model: config.model,
      baseUrl: config.baseUrl || undefined,
      region: config.region || undefined,
      authType: config.authType || undefined,
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
      <h2 className="text-xl font-bold text-[var(--color-on-surface)] mb-1">LLM Provider</h2>
      <p className="text-[var(--color-on-surface-variant)] text-sm mb-6">Choose the AI model that powers your investigations.</p>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Providers</label>
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
                  });
                  setTestResult(null);
                  setRemoteModels([]);
                  setModelsFetched(false);
                  setModelsWarning(null);
                }}
                className={`text-left px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors ${
                  config.provider === p.value
                    ? 'border-[var(--color-primary)] bg-[var(--color-surface-high)] text-[var(--color-primary)]'
                    : 'border-[var(--color-outline-variant)] text-[var(--color-on-surface-variant)] hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-high)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {provider.needsKey && (
          <div>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">API Key</label>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => {
                onChange({ apiKey: e.target.value });
                setTestResult(null);
              }}
              placeholder="sk-..."
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            />
          </div>
        )}

        {provider.needsUrl && (
          <div>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">
              {config.provider === 'ollama' ? 'Ollama URL' : 'Endpoint URL'}
            </label>
            <input
              type="url"
              value={config.baseUrl}
              onChange={(e) => {
                onChange({ baseUrl: e.target.value });
                setTestResult(null);
              }}
              placeholder={llmBaseUrlPlaceholder(config.provider)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            />
          </div>
        )}

        {provider.needsRegion && (
          <div>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">AWS Region</label>
            <input
              type="text"
              value={config.region}
              onChange={(e) => {
                onChange({ region: e.target.value });
                setTestResult(null);
              }}
              placeholder="us-east-1"
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Default Model</label>
          <div className="flex gap-2 items-stretch min-w-0">
            <select
              value={config.model}
              onChange={(e) => onChange({ model: e.target.value })}
              className="flex-1 min-w-0 w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)] truncate"
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
                className="px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] text-sm font-medium text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {fetchingModels ? 'Loading...' : 'Fetch Models'}
              </button>
            )}
          </div>
          {modelsFetched && remoteModels.length === 0 && (
            <p className="text-xs text-tertiary mt-1">
              {modelsWarning ?? 'Could not fetch models. Check your API key / URL and try again.'}
            </p>
          )}
          {remoteModels.length > 0 && (
            <p className="text-xs text-secondary mt-1">
              Found {remoteModels.length} models from provider
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing || !canProceed}
            className="px-4 py-2 rounded-lg border border-[var(--color-outline-variant)] text-sm font-medium text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testResult && (
            <span className={`text-sm font-medium ${testResult.ok ? 'text-secondary' : 'text-error'}`}>
              {testResult.ok ? '✓ ' : '✗ '}
              {testResult.message}
            </span>
          )}
        </div>

        <div className="flex justify-between mt-8">
          <button type="button" onClick={onBack} className="px-5 py-2 text-sm font-medium text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">
            ← Back
          </button>
          <button
            type="button"
            onClick={() => void handleNext()}
            disabled={!canProceed}
            className="px-5 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
