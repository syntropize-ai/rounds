import { DEFAULT_LLM_MODEL } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { LlmConfigWire } from '@agentic-obs/common';
import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  ProviderError,
  type ModelInfo,
} from '@agentic-obs/llm-gateway';
import { ensureSafeUrl } from '../utils/url-validator.js';

const log = createLogger('setup-llm-service');

const PROVIDER_PROBE_TIMEOUT_MS = 15_000;

export interface LlmConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface FetchModelsResult {
  models: ModelInfo[];
  /**
   * When the provider listModels call failed, callers can surface this as a
   * UI-visible warning string instead of treating an empty list as success.
   */
  errorMessage?: string;
}

export interface FetchModelsInput {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}

export class SetupLlmServiceError extends Error {
  constructor(
    public readonly kind: 'invalid_url',
    message: string,
  ) {
    super(message);
    this.name = 'SetupLlmServiceError';
  }
}

function resolveToken(cfg: LlmConfigWire): string | null {
  return cfg.apiKey ?? null;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return `Provider did not respond within ${Math.round(PROVIDER_PROBE_TIMEOUT_MS / 1000)}s`;
    }
    return err.message;
  }
  return 'Connection failed';
}

async function guardProviderUrl(
  finalUrl: string,
  _userSuppliedBase: string | undefined,
): Promise<void> {
  // Always validate. Known-public defaults (api.openai.com, api.anthropic.com,
  // generativelanguage.googleapis.com) pass ensureSafeUrl trivially. The
  // Ollama default (http://localhost:11434) is a private host and is gated
  // by OPENOBS_ALLOW_PRIVATE_URLS / NODE_ENV — which is the correct
  // production posture (containerized prod must opt in explicitly).
  await ensureSafeUrl(finalUrl);
}

function buildModelsProbeUrl(provider: string, baseUrl: string): string | null {
  switch (provider) {
    case 'anthropic':
      return `${baseUrl}/v1/models`;
    case 'openai':
    case 'deepseek':
      return `${baseUrl}/models`;
    case 'gemini':
      return `${baseUrl}/v1beta/models`;
    case 'ollama':
      return `${baseUrl}/api/tags`;
    default:
      return null;
  }
}

export class SetupLlmService {
  async testConnection(cfg: LlmConfigWire): Promise<LlmConnectionTestResult> {
    try {
      if (cfg.provider === 'corporate-gateway') {
        const token = resolveToken(cfg);
        if (!token) return { ok: false, message: 'Bearer token or API key is required' };
        const baseUrl = cfg.baseUrl;
        if (!baseUrl) return { ok: false, message: 'Gateway base URL is required' };

        const target = `${baseUrl}/v1/messages`;
        await guardProviderUrl(target, baseUrl);

        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.authType === 'bearer'
              ? { Authorization: `Bearer ${token}` }
              : { 'api-key': token }),
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: cfg.model || DEFAULT_LLM_MODEL,
            messages: [{ role: 'user', content: 'Say "ok".' }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
        });

        if (res.ok) return { ok: true, message: 'Connected via corporate gateway' };
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
      }

      if (cfg.provider === 'anthropic') {
        const key = cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
        if (!key) return { ok: false, message: 'API key is required' };
        const baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
        const target = `${baseUrl}/v1/models`;
        await guardProviderUrl(target, cfg.baseUrl);
        const res = await fetch(target, {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
        });
        if (res.ok) return { ok: true, message: 'Connected successfully' };
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
      }

      if (cfg.provider === 'openai' || cfg.provider === 'deepseek') {
        const key = cfg.apiKey ?? '';
        if (!key) return { ok: false, message: 'API key is required' };
        const base =
          cfg.provider === 'deepseek'
            ? cfg.baseUrl || 'https://api.deepseek.com/v1'
            : cfg.baseUrl || 'https://api.openai.com/v1';
        const target = `${base}/models`;
        await guardProviderUrl(target, cfg.baseUrl);
        const res = await fetch(target, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
        });
        if (res.ok) return { ok: true, message: 'Connected successfully' };
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
      }

      if (cfg.provider === 'ollama') {
        const base = cfg.baseUrl || 'http://localhost:11434';
        const target = `${base}/api/tags`;
        await guardProviderUrl(target, cfg.baseUrl);
        const res = await fetch(target, {
          signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
        });
        if (res.ok) return { ok: true, message: 'Connected successfully' };
        return { ok: false, message: `HTTP ${res.status}` };
      }

      if (cfg.provider === 'gemini') {
        const key = cfg.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
        if (!key) return { ok: false, message: 'API key is required' };
        const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
        const target = `${base}/v1beta/models?key=${key}`;
        await guardProviderUrl(target, cfg.baseUrl);
        const res = await fetch(target, {
          signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
        });
        if (res.ok) return { ok: true, message: 'Connected successfully' };
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, message: body.error?.message ?? `HTTP ${res.status}` };
      }

      if (cfg.provider === 'azure-openai') {
        if (!cfg.apiKey || !cfg.baseUrl)
          return { ok: false, message: 'API key and endpoint URL are required' };
        return { ok: true, message: 'Configuration looks valid (live test not performed)' };
      }

      if (cfg.provider === 'aws-bedrock') {
        if (!cfg.region) return { ok: false, message: 'AWS region is required' };
        return { ok: true, message: 'Configuration looks valid (live test not performed)' };
      }

      return { ok: false, message: 'Unknown provider' };
    } catch (err) {
      log.warn(
        { err, provider: cfg.provider, baseUrl: cfg.baseUrl },
        'LLM test-connection failed',
      );
      return { ok: false, message: describeFetchError(err) };
    }
  }

  async fetchModels(cfg: FetchModelsInput): Promise<FetchModelsResult> {
    if (cfg.baseUrl) {
      const probeUrl = buildModelsProbeUrl(cfg.provider, cfg.baseUrl);
      if (probeUrl) {
        try {
          await ensureSafeUrl(probeUrl);
        } catch (err) {
          throw new SetupLlmServiceError(
            'invalid_url',
            err instanceof Error ? err.message : 'Invalid URL',
          );
        }
      }
    }

    try {
      switch (cfg.provider) {
        case 'anthropic': {
          const provider = new AnthropicProvider({
            apiKey: cfg.apiKey ?? '',
            baseUrl: cfg.baseUrl,
          });
          return { models: await provider.listModels() };
        }
        case 'openai': {
          const provider = new OpenAIProvider({
            apiKey: cfg.apiKey ?? '',
            baseUrl: cfg.baseUrl,
          });
          return { models: await provider.listModels() };
        }
        case 'deepseek': {
          return { models: await this.fetchDeepseekModels(cfg.apiKey ?? '', cfg.baseUrl) };
        }
        case 'gemini': {
          const provider = new GeminiProvider({
            apiKey: cfg.apiKey ?? '',
            baseUrl: cfg.baseUrl,
          });
          return { models: await provider.listModels() };
        }
        case 'ollama': {
          const provider = new OllamaProvider({ baseUrl: cfg.baseUrl });
          return { models: await provider.listModels() };
        }
        default:
          return { models: [] };
      }
    } catch (err) {
      log.warn({ err, provider: cfg.provider, baseUrl: cfg.baseUrl }, 'fetchModels failed');
      if (err instanceof ProviderError) {
        const detail =
          err.kind === 'auth'
            ? 'API key was rejected'
            : err.kind === 'network'
              ? 'could not reach the provider'
              : err.kind === 'unsupported'
                ? 'provider does not expose a model list endpoint'
                : err.message;
        return { models: [], errorMessage: `${cfg.provider}: ${detail}` };
      }
      return {
        models: [],
        errorMessage: `${cfg.provider}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async fetchDeepseekModels(apiKey: string, baseUrl?: string): Promise<ModelInfo[]> {
    const base = baseUrl || 'https://api.deepseek.com/v1';
    const target = `${base}/models`;
    try {
      if (baseUrl) await ensureSafeUrl(target);
      const res = await fetch(target, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn({ status: res.status, base }, 'DeepSeek /models returned non-OK');
        return [];
      }
      const body = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
      const data = body.data ?? [];
      return data
        .map((m) => m.id)
        .sort()
        .map((id) => ({ id, name: id, provider: 'deepseek' }));
    } catch (err) {
      log.warn({ err, base }, 'DeepSeek /models fetch failed');
      return [];
    }
  }
}
