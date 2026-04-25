// Core types for the LLM Gateway unified invocation layer

export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * A single message in a conversation. `content` is either a plain string
 * (legacy / simple turns) or an array of typed blocks (native tool_use
 * protocol). When the loop sends an assistant turn back as history, it
 * uses the block form so the model sees its own previous tool_use calls
 * in their original shape — without that, replaying as a JSON-stringified
 * `{action, args}` blob teaches the model that prose-JSON is a valid
 * response, and it eventually drifts back to emitting prose instead of
 * native tool_use blocks.
 */
export interface CompletionMessage {
  role: MessageRole;
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

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
