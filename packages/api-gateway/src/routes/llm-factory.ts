import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  LLMGateway,
  type LLMProvider,
} from '@agentic-obs/llm-gateway';
import type { InstanceLlmConfig, LlmApiFormat } from '@agentic-obs/common';

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
    case 'azure-openai':
      return new OpenAIProvider({
        apiKey,
        baseUrl: cfg.baseUrl || undefined,
      });

    case 'deepseek':
      return new OpenAIProvider({
        apiKey,
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
      return new OpenAIProvider({ apiKey, baseUrl: base });
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
 */
export function createLlmGateway(cfg: LlmFactoryConfig, maxRetries = 2): LLMGateway {
  return new LLMGateway({ primary: createLlmProvider(cfg), maxRetries });
}
