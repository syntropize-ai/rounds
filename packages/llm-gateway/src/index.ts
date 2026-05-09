// @agentic-obs/llm-gateway — Unified LLM invocation layer

export type {
  CompletionMessage,
  ContentBlock,
  LLMOptions,
  LLMUsage,
  LLMResponse,
  LLMProvider,
  MessageRole,
  ModelInfo,
  ProviderErrorKind,
  ToolDefinition,
  ToolCall,
  JsonSchemaObject,
  JsonSchemaProperty,
} from './types.js';
export { ProviderError, classifyProviderHttpError } from './types.js';
export type { ProviderCapabilities } from './providers/capabilities.js';
export { getCapabilities, ProviderCapabilityError } from './providers/capabilities.js';
export { LLMGateway } from './gateway.js';
export type { GatewayConfig, TokenMetrics } from './gateway.js';
export { OpenAIProvider, OpenAICompatibleProvider } from './providers/openai.js';
export type { OpenAIConfig, OpenAICompatibleConfig } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export type { AnthropicConfig } from './providers/anthropic.js';
export { MockProvider } from './providers/mock.js';
export type { MockProviderConfig } from './providers/mock.js';
export { GeminiProvider } from './providers/gemini.js';
export type { GeminiConfig } from './providers/gemini.js';
export { OllamaProvider } from './providers/ollama.js';
export type { OllamaConfig } from './providers/ollama.js';
export {
  buildApiKeyResolver,
  ApiKeyHelperConfigError,
  _resetApiKeyHelperCacheForTests,
} from './api-key-helper.js';
export type { ApiKeyResolverOptions, ApiKeyHelperConfig } from './api-key-helper.js';
