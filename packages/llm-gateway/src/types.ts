// Core types for the LLM Gateway unified invocation layer

export type MessageRole = 'system' | 'user' | 'assistant';

export interface CompletionMessage {
  role: MessageRole;
  content: string;
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string;
  usage: LLMUsage;
  model: string;
  latencyMs: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  description?: string;
}

export interface LLMProvider {
  name: string;
  complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse>;
  /** Fetch available models from the provider. Returns empty array if listing is unsupported. */
  listModels?(): Promise<ModelInfo[]>;
}
