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
  | { type: 'tool_result'; tool_use_id: string; tool_name: string; content: string; is_error?: boolean };

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
  /**
   * Extended thinking / reasoning. `effort` is a portable enum that each
   * provider maps to its native shape (Anthropic budget_tokens, OpenAI
   * reasoning_effort, Gemini thinkingBudget). Silently ignored when the
   * provider/model doesn't support thinking — capability is the gatekeeper.
   */
  thinking?: { effort: 'low' | 'medium' | 'high' };
  /**
   * Abort signal — when the client disconnects mid-stream, the chat router
   * triggers this so the in-flight provider fetch aborts immediately and the
   * agent loop unwinds with an AbortError instead of running expensive LLM
   * calls to completion against a closed socket.
   */
  signal?: AbortSignal;
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
  /**
   * Extended-thinking / reasoning blocks the model emitted before producing
   * its response. Empty when thinking wasn't enabled or the provider doesn't
   * surface its reasoning. UI can render these in a collapsed widget.
   */
  thinkingBlocks?: string[];
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

// -- Provider errors -----------------------------------------------------
//
// Typed error raised by provider methods (listModels, complete) when an
// integration boundary fails. Callers branch on `kind` to decide whether
// to retry, surface a setup error, or bubble.
//
//   - 'auth'        : credentials rejected (401, missing API key, etc).
//                     Don't retry; surface as setup error.
//   - 'network'     : transport-level (DNS, connection refused, timeout)
//                     or 5xx server errors. Retryable.
//   - 'unsupported' : operation isn't available for this provider/model
//                     (404 on listModels, capability missing). Don't retry.
//   - 'unknown'     : unclassified — caller decides. Default to don't retry
//                     so we fail fast on novel errors instead of hammering.

export type ProviderErrorKind = 'auth' | 'network' | 'unsupported' | 'unknown';

export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly provider: string;
  public readonly status?: number;
  public override readonly cause?: unknown;
  /** Seconds the upstream asked us to wait (Retry-After header). */
  public readonly retryAfterSec?: number;

  constructor(
    message: string,
    opts: {
      kind: ProviderErrorKind;
      provider: string;
      status?: number;
      cause?: unknown;
      retryAfterSec?: number;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.provider = opts.provider;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }
}

/**
 * Classify a fetch / Response failure into a ProviderErrorKind. Covers the
 * common shapes: HTTP status (401 → auth, 5xx → network, 404 → unsupported),
 * Node fetch error codes (ENOTFOUND/ECONNREFUSED/ETIMEDOUT → network), and
 * 429 rate-limit (network — retryable, the gateway honors Retry-After).
 */
export function classifyProviderHttpError(opts: {
  status?: number;
  cause?: unknown;
}): ProviderErrorKind {
  const { status, cause } = opts;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'unsupported';
    if (status === 429) return 'network';
    if (status >= 500) return 'network';
    if (status >= 400) return 'unknown';
  }
  // Inspect Node fetch error code / nested cause
  const codes: string[] = [];
  const collect = (e: unknown) => {
    if (!e || typeof e !== 'object') return;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    const inner = (e as { cause?: unknown }).cause;
    if (inner) collect(inner);
  };
  collect(cause);
  if (codes.some((c) => /^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET))$/i.test(c))) {
    return 'network';
  }
  if (cause instanceof Error && cause.name === 'AbortError') return 'network';
  return 'unknown';
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
