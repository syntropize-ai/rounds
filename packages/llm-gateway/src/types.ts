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
  /**
   * Response format. 'json' has been removed — every call either uses native
   * tool_use (via `tools`) or returns plain text. Structured output is the
   * tool-call's `input`, not parsed prose.
   */
  responseFormat?: 'text';
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  /** Plain text — the model's prose / pre-tool narration. May be '' when only tools were called. */
  content: string;
  /** Tool calls emitted this turn. Empty array if the model didn't invoke any tool. */
  toolCalls: ToolCall[];
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

// -- Native tool_use API contract --

export interface ToolDefinition {
  name: string;
  /** 1-2 sentences telling the model when to use it. */
  description: string;
  input_schema: JsonSchemaObject;
}

export interface ToolCall {
  /** Provider's id (Anthropic toolu_*, OpenAI call_*). Echoed back in tool_result blocks. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// -- Minimal subset of JSON Schema we care about --

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}
