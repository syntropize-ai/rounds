// @agentic-obs/llm-gateway — Unified LLM invocation layer

export type { CompletionMessage, LLMOptions, LLMUsage, LLMResponse, LLMProvider, MessageRole, ModelInfo } from './types.js';
export { LLMGateway } from './gateway.js';
export type { GatewayConfig, TokenMetrics } from './gateway.js';
export { AuditLogger } from './audit.js';
export type { AuditEntry } from './audit.js';
export { OpenAIProvider } from './providers/openai.js';
export type { OpenAIConfig } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export type { AnthropicConfig } from './providers/anthropic.js';
export { MockProvider } from './providers/mock.js';
export type { MockProviderConfig } from './providers/mock.js';
export { GeminiProvider } from './providers/gemini.js';
export type { GeminiConfig } from './providers/gemini.js';
export { OllamaProvider } from './providers/ollama.js';
export type { OllamaConfig } from './providers/ollama.js';
export { SmartModelRouter } from './router/index.js';
export type { ModelConfig, TaskDescription, ModelSelection, SmartRouterConfig } from './router/index.js';
