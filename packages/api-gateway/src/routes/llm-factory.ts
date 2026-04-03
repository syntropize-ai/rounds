import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  LLMGateway,
  type LLMProvider,
} from '@agentic-obs/llm-gateway';
import type { LlmConfig } from './setup.js';

/**
 * Create the correct LLMProvider based on the user's setup config.
 */
export function createLlmProvider(cfg: LlmConfig): LLMProvider {
  const isCorporateGateway = cfg.provider === 'corporate-gateway' || !!cfg.tokenHelperCommand;

  switch (cfg.provider) {
    case 'openai':
    case 'azure-openai':
      return new OpenAIProvider({
        apiKey: cfg.apiKey ?? '',
        baseUrl: cfg.baseUrl || undefined,
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
export function createLlmGateway(cfg: LlmConfig, maxRetries = 2): LLMGateway {
  return new LLMGateway({ primary: createLlmProvider(cfg), maxRetries });
}
