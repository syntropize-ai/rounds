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
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * Provider-specific opaque metadata that MUST round-trip back to the
       * provider on replay. Examples:
       *   - Gemini thinking models attach a `thought_signature` to each
       *     functionCall part; the next request's history must echo it or
       *     the API rejects with 400 ("missing thought_signature").
       *   - Anthropic extended-thinking attaches a per-block signature to
       *     `tool_use` blocks emitted from a thinking turn.
       * Treat as passthrough — the gateway does not interpret the contents.
       */
      providerMetadata?: Record<string, unknown>;
    }
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
  /**
   * Provider-specific opaque metadata that the agent loop must thread back
   * onto the matching `tool_use` ContentBlock when replaying conversation
   * history. See `ContentBlock['tool_use'].providerMetadata` for the
   * load-bearing example (Gemini thoughtSignature).
   */
  providerMetadata?: Record<string, unknown>;
}

// -- Provider errors -----------------------------------------------------
//
// `ProviderError` is the LLM-gateway flavor of the canonical AdapterError
// taxonomy in `@agentic-obs/adapters`. It is the same class, with the same
// `kind` enum — `ProviderError` exists for back-compat with callers that
// still `instanceof ProviderError` (api-gateway setup flow). New code should
// `instanceof AdapterError` and branch on `error.kind`.
//
// `kind` values use the canonical AdapterErrorKind:
//   timeout, dns_failure, connection_refused, auth_failure, rate_limit,
//   not_found, bad_request, server_error, malformed_response, readonly,
//   unknown.

import {
  AdapterError,
  classifyHttpError,
  type AdapterErrorKind,
} from '@agentic-obs/adapters';

export type ProviderErrorKind = AdapterErrorKind;

/**
 * Subclass exists to preserve back-compat with `instanceof ProviderError`
 * catch sites and to surface provider-specific accessor names (`provider`,
 * `retryAfterSec`, `upstreamCode`, `upstreamBody`) without callers having to
 * dig into `cause`.
 */
export class ProviderError extends AdapterError {
  /** Convenience alias for `cause.adapterId`. */
  public readonly provider: string;
  /** Convenience alias for `cause.status`. */
  public readonly status: number | undefined;
  /** Convenience alias for `cause.retryAfterSec`. */
  public readonly retryAfterSec: number | undefined;
  /** Convenience alias for `cause.providerCode`. */
  public readonly upstreamCode: string | undefined;
  /** Convenience alias for `cause.upstreamBody`. Never safe to show to users. */
  public readonly upstreamBody: string | undefined;

  constructor(
    message: string,
    opts: {
      kind: ProviderErrorKind;
      provider: string;
      status?: number;
      cause?: unknown;
      retryAfterSec?: number;
      upstreamCode?: string;
      upstreamBody?: string;
    },
  ) {
    super(opts.kind, message, {
      adapterId: opts.provider,
      operation: 'complete',
      status: opts.status,
      providerCode: opts.upstreamCode,
      retryAfterSec: opts.retryAfterSec,
      upstreamBody: opts.upstreamBody,
      originalError: opts.cause,
    });
    this.name = 'ProviderError';
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec;
    this.upstreamCode = opts.upstreamCode;
    this.upstreamBody = opts.upstreamBody;
  }
}

/**
 * Classify a fetch / Response failure into a canonical ProviderErrorKind.
 * Thin wrapper around the shared `classifyHttpError` so provider code can
 * keep its existing import.
 */
export function classifyProviderHttpError(opts: {
  status?: number;
  cause?: unknown;
}): ProviderErrorKind {
  return classifyHttpError(opts);
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
