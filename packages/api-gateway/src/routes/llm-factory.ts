import {
  AnthropicProvider,
  OpenAIProvider,
  OpenAICompatibleProvider,
  GeminiProvider,
  OllamaProvider,
  LLMGateway,
  type LLMProvider,
  type AuditSink,
  type AuditEntry,
} from '@agentic-obs/llm-gateway';
import type { InstanceLlmConfig, LlmApiFormat } from '@agentic-obs/common';
import type { ILlmAuditRepository } from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/common/logging';
import { llmCallsTotal, llmLatency, llmTokensTotal } from '../metrics.js';

const auditLog = createLogger('llm-audit-sink');

/**
 * Adapt the data-layer `ILlmAuditRepository` to the gateway's `AuditSink`
 * shape. Errors are logged-and-swallowed because audit-write failures must
 * never break a live LLM call. The decoupling rule (llm-gateway never
 * imports data-layer) is preserved by this adapter living in api-gateway.
 */
export function createDbAuditSink(repo: ILlmAuditRepository): AuditSink {
  return {
    async record(entry: AuditEntry): Promise<void> {
      try {
        await repo.insert({
          id: entry.id,
          requestedAt: entry.requestedAt,
          provider: entry.provider,
          model: entry.model,
          promptHash: entry.promptHash,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          totalTokens: entry.totalTokens,
          cachedTokens: entry.cachedTokens ?? null,
          costUsd: entry.costUsd,
          latencyMs: entry.latencyMs,
          success: entry.success,
          errorKind: entry.errorKind ?? null,
          abortReason: entry.abortReason ?? null,
          orgId: entry.orgId ?? null,
          userId: entry.userId ?? null,
          sessionId: entry.sessionId ?? null,
        });
      } catch (err) {
        auditLog.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to persist llm_audit row',
        );
      }
    },
  };
}

/**
 * Minimal shape accepted by the factory. The repository-shaped
 * `InstanceLlmConfig` carries extra bookkeeping (updatedAt, updatedBy)
 * the factory doesn't need, but it's the canonical shape now that we've
 * deleted the old flat-file `LlmConfig`. Accepting the wider type here
 * means callers can pass the repository object straight through.
 */
export type LlmFactoryConfig = Pick<
  InstanceLlmConfig,
  'provider' | 'apiKey' | 'model' | 'baseUrl' | 'authType' | 'region' | 'apiKeyHelper' | 'apiFormat'
>;

/**
 * Create the correct LLMProvider based on the user's setup config.
 *
 * For native providers (`anthropic` / `openai` / etc.), the wire format is
 * implied by the provider name. For `corporate-gateway`, the user explicitly
 * picks `apiFormat` and we dispatch to the matching native implementation —
 * the gateway URL just becomes that provider's `baseUrl`.
 */
export function createLlmProvider(cfg: LlmFactoryConfig): LLMProvider {
  const apiKey = cfg.apiKey ?? '';
  const apiKeyHelper = cfg.apiKeyHelper ?? undefined;

  if (cfg.provider === 'corporate-gateway') {
    return createForCorpGateway(cfg.apiFormat ?? 'anthropic', cfg.baseUrl, apiKey, apiKeyHelper);
  }

  switch (cfg.provider) {
    case 'openai':
      return createOpenAiProvider(apiKey, apiKeyHelper, cfg.baseUrl);

    case 'azure-openai':
      return new OpenAICompatibleProvider({
        providerId: 'azure-openai',
        providerName: 'Azure OpenAI',
        apiKey,
        ...(apiKeyHelper ? { apiKeyHelper } : {}),
        baseUrl: cfg.baseUrl || 'https://api.openai.com/v1',
      });

    case 'deepseek':
      return new OpenAICompatibleProvider({
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        apiKey,
        ...(apiKeyHelper ? { apiKeyHelper } : {}),
        baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
      });

    case 'gemini':
      return new GeminiProvider({
        apiKey,
        baseUrl: cfg.baseUrl || undefined,
      });

    case 'ollama':
      return new OllamaProvider({
        baseUrl: cfg.baseUrl || undefined,
      });

    case 'anthropic':
    default:
      return new AnthropicProvider({
        apiKey,
        ...(apiKeyHelper ? { apiKeyHelper } : {}),
        baseUrl: cfg.baseUrl || undefined,
      });
  }
}

function createOpenAiProvider(
  apiKey: string,
  apiKeyHelper: string | undefined,
  baseUrl: string | null | undefined,
): LLMProvider {
  if (!baseUrl || isOfficialOpenAiBaseUrl(baseUrl)) {
    return new OpenAIProvider({
      apiKey,
      ...(apiKeyHelper ? { apiKeyHelper } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  return new OpenAICompatibleProvider({
    providerId: inferOpenAiCompatibleProviderId(baseUrl),
    providerName: inferOpenAiCompatibleProviderName(baseUrl),
    apiKey,
    ...(apiKeyHelper ? { apiKeyHelper } : {}),
    baseUrl,
  });
}

function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function inferOpenAiCompatibleProviderId(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname.includes('openrouter.ai')) return 'openrouter';
    if (hostname.includes('deepseek.com')) return 'deepseek';
  } catch {
    // Fall through to a stable generic id for malformed/custom URLs. URL
    // safety validation happens at the route/service boundary.
  }
  return 'openai-compatible';
}

function inferOpenAiCompatibleProviderName(baseUrl: string): string {
  const id = inferOpenAiCompatibleProviderId(baseUrl);
  if (id === 'openrouter') return 'OpenRouter';
  if (id === 'deepseek') return 'DeepSeek';
  return 'OpenAI-compatible';
}

function createForCorpGateway(
  apiFormat: LlmApiFormat,
  baseUrl: string | null | undefined,
  apiKey: string,
  apiKeyHelper: string | undefined,
): LLMProvider {
  const base = baseUrl || undefined;
  const helperOpt = apiKeyHelper ? { apiKeyHelper } : {};
  switch (apiFormat) {
    case 'openai':
      return new OpenAICompatibleProvider({
        providerId: 'corporate-gateway',
        providerName: 'Corporate Gateway',
        apiKey,
        ...helperOpt,
        baseUrl: base ?? 'https://api.openai.com/v1',
      });
    case 'gemini':
      return new GeminiProvider({ apiKey, baseUrl: base });
    case 'anthropic-bedrock':
      return new AnthropicProvider({
        apiKey,
        ...helperOpt,
        baseUrl: base,
        endpointFlavor: 'bedrock',
      });
    case 'anthropic':
    default:
      return new AnthropicProvider({
        apiKey,
        ...helperOpt,
        baseUrl: base,
      });
  }
}

/**
 * Create an LLMGateway from the user's setup config.
 *
 * `auditSink` is optional: when provided, audit rows persist to the database;
 * when omitted, the gateway uses its in-memory default (lost on restart).
 */
export function createLlmGateway(
  cfg: LlmFactoryConfig,
  maxRetries = 2,
  auditSink?: AuditSink,
): LLMGateway {
  return new LLMGateway({
    primary: createLlmProvider(cfg),
    maxRetries,
    ...(auditSink ? { auditSink } : {}),
    metricsObserver: {
      recordSuccess(event) {
        llmCallsTotal.inc({ provider: event.provider, model: event.model, status: 'success' });
        llmLatency.observe({ provider: event.provider, model: event.model }, event.latencyMs / 1000);
        llmTokensTotal.inc({ provider: event.provider, type: 'prompt' }, event.promptTokens);
        llmTokensTotal.inc({ provider: event.provider, type: 'completion' }, event.completionTokens);
      },
      recordFailure(event) {
        llmCallsTotal.inc({ provider: event.provider, model: event.model, status: 'error' });
        llmLatency.observe({ provider: event.provider, model: event.model }, event.latencyMs / 1000);
      },
    },
  });
}
