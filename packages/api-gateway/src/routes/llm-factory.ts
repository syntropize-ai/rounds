import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  LLMGateway,
  type LLMProvider,
} from '@agentic-obs/llm-gateway';
import type { InstanceLlmConfig } from '@agentic-obs/common';

/**
 * Minimal shape accepted by the factory. The repository-shaped
 * `InstanceLlmConfig` carries extra bookkeeping (updatedAt, updatedBy)
 * the factory doesn't need, but it's the canonical shape now that we've
 * deleted the old flat-file `LlmConfig`. Accepting the wider type here
 * means callers can pass the repository object straight through.
 */
export type LlmFactoryConfig = Pick<
  InstanceLlmConfig,
  'provider' | 'apiKey' | 'model' | 'baseUrl' | 'authType' | 'region'
>;

/**
 * Create the correct LLMProvider based on the user's setup config.
 */
export function createLlmProvider(cfg: LlmFactoryConfig): LLMProvider {
  const isCorporateGateway = cfg.provider === 'corporate-gateway';

  switch (cfg.provider) {
    case 'openai':
    case 'azure-openai':
      return new OpenAIProvider({
        apiKey: cfg.apiKey ?? '',
        baseUrl: cfg.baseUrl || undefined,
      });

    case 'deepseek':
      return new OpenAIProvider({
        apiKey: cfg.apiKey ?? '',
        baseUrl: cfg.baseUrl || 'https://api.deepseek.com',
      });

    case 'gemini':
      return new GeminiProvider({
        apiKey: cfg.apiKey ?? '',
        baseUrl: cfg.baseUrl || undefined,
      });

    case 'ollama':
      return new OllamaProvider({
        baseUrl: cfg.baseUrl || undefined,
      });

    case 'anthropic':
    case 'corporate-gateway':
    default:
      return new AnthropicProvider({
        apiKey: cfg.apiKey ?? '',
        baseUrl: cfg.baseUrl || undefined,
        apiType: isCorporateGateway
          ? (cfg.authType ?? 'bearer') as 'api-key' | 'bearer'
          : (cfg.authType ?? 'api-key') as 'api-key' | 'bearer',
      });
  }
}

/**
 * Create an LLMGateway from the user's setup config.
 */
export function createLlmGateway(cfg: LlmFactoryConfig, maxRetries = 2): LLMGateway {
  return new LLMGateway({ primary: createLlmProvider(cfg), maxRetries });
}
