import { createLogger } from '@agentic-obs/server-utils/logging';
import type {
  LLMProvider,
  LLMOptions,
  LLMResponse,
  CompletionMessage,
  ContentBlock,
  ModelInfo,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { ProviderError, classifyProviderHttpError } from '../types.js';
import { getCapabilities } from './capabilities.js';
import { buildApiKeyResolver } from '../api-key-helper.js';
import { stripCacheBoundary } from '../system-prompt-cache-boundary.js';

const log = createLogger('openai-provider');

export interface OpenAIConfig {
  apiKey: string;
  apiKeyHelper?: string;
  baseUrl?: string;
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  apiKeyHelper?: string;
  baseUrl: string;
  providerId: string;
  providerName?: string;
}

// -- Tool name normalization --
//
// OpenAI's Chat Completions API restricts function names to
// `^[a-zA-Z0-9_-]{1,64}$`, so the dotted canonical names we use in agent-core
// (e.g. `metrics.query`, `dashboard.add_panels`) get rejected outright.
// We translate `.` <-> `__` on the wire. Double-underscore is unlikely to
// collide with our existing canonical names (none currently contain `__`),
// and is symmetrical so the round-trip is lossless. If a future canonical
// name ever uses `__` we'd need a richer encoding.
const NAME_DELIM = '__';

function nameToOpenAi(canonical: string): string {
  return canonical.replace(/\./g, NAME_DELIM);
}

function nameFromOpenAi(openai: string): string {
  return openai.replace(new RegExp(NAME_DELIM, 'g'), '.');
}

// -- OpenAI request/response shapes (the bits we touch) --

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['input_schema'];
    /**
     * OpenAI strict tool-call mode — when true, the model is grammar-
     * constrained to emit JSON conforming exactly to `parameters`. Costs
     * one extra prompt cache miss the first time each schema is seen,
     * then provides hard guarantees no LLM-side malformed-JSON recovery
     * can match. DeepSeek (OpenAI-compatible) honors this flag.
     */
    strict?: boolean;
  };
}

/**
 * Walk a JSON schema and apply OpenAI strict-mode invariants:
 *   - every `object` node MUST set `additionalProperties: false`
 *   - every property MUST appear in `required` (optionality is expressed
 *     by `type: [..., 'null']` instead)
 *
 * Strict mode caveats this addresses:
 *  1. additionalProperties default is `true`, which strict mode rejects.
 *  2. The OpenAI strict-mode workaround for optional fields is to keep
 *     them in `required` and make the type nullable. We apply that
 *     transformation here so existing schemas (whose authors used
 *     `required: ['a']` to mean "a is required, b is optional") still
 *     work under strict mode without manual rewriting.
 *
 * Returns a NEW object — never mutates the input. The transformation is
 * purely structural; types referenced by `$ref` are NOT followed (we
 * don't emit refs anywhere in this codebase).
 */
export function prepareToolSchemaForStrict(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(prepareToolSchemaForStrict);
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };

  // Recurse into common schema-bearing fields.
  if (s['items'] !== undefined) {
    out['items'] = prepareToolSchemaForStrict(s['items']);
  }
  if (s['anyOf'] !== undefined && Array.isArray(s['anyOf'])) {
    out['anyOf'] = s['anyOf'].map(prepareToolSchemaForStrict);
  }
  if (s['oneOf'] !== undefined && Array.isArray(s['oneOf'])) {
    out['oneOf'] = s['oneOf'].map(prepareToolSchemaForStrict);
  }

  // Object-shaped node — apply both invariants.
  const isObject = s['type'] === 'object' || (s['properties'] !== undefined && s['type'] === undefined);
  if (isObject) {
    const propsRaw = (s['properties'] as Record<string, unknown> | undefined) ?? {};
    const transformedProps: Record<string, unknown> = {};
    const propNames: string[] = [];
    for (const [k, v] of Object.entries(propsRaw)) {
      propNames.push(k);
      const child = prepareToolSchemaForStrict(v) as Record<string, unknown>;
      // Determine whether this property was originally optional. If so, make
      // its type nullable so the model can emit `null` instead of omitting.
      const originalRequired = Array.isArray(s['required']) ? (s['required'] as string[]) : [];
      if (!originalRequired.includes(k) && child && typeof child === 'object') {
        const t = child['type'];
        if (typeof t === 'string' && t !== 'null') {
          child['type'] = [t, 'null'];
        } else if (Array.isArray(t) && !t.includes('null')) {
          child['type'] = [...t, 'null'];
        }
      }
      transformedProps[k] = child;
    }
    out['properties'] = transformedProps;
    out['required'] = propNames;
    out['additionalProperties'] = false;
  }

  return out;
}

/** Env-gated strict-mode toggle. Default ON; set LLM_STRICT_TOOL_CALLS=0 to disable. */
export function isStrictToolCallsEnabled(): boolean {
  return process.env['LLM_STRICT_TOOL_CALLS'] !== '0';
}

type OpenAIToolChoice = 'auto' | 'required' | { type: 'function'; function: { name: string } } | undefined;

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string of the arguments object. */
    arguments: string;
  };
}

interface OpenAIResponseBody {
  model: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      // Reasoning summary fields. Different providers expose this under
      // different keys when wrapped through OpenAI-compatible endpoints:
      //   - DeepSeek R1, Qwen-Thinking: `reasoning_content`
      //   - OpenRouter (transparent reasoning), some Gemini wrappers: `reasoning`
      // Either may be a string OR an array of {text} blocks. We collect
      // both and surface them as `thinkingBlocks` so the chat UI can render
      // the model's chain-of-thought instead of an empty bubble.
      reasoning_content?: string | Array<{ text?: string }>;
      reasoning?: string | Array<{ text?: string }>;
    };
    finish_reason?: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function parseRetryAfterSec(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function extractUpstreamCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const direct = (parsed as { code?: unknown }).code;
    if (typeof direct === 'string' && direct.trim()) return direct;
    const nested = (parsed as { error?: unknown }).error;
    if (nested && typeof nested === 'object') {
      const code = (nested as { code?: unknown; type?: unknown }).code ?? (nested as { type?: unknown }).type;
      if (typeof code === 'string' && code.trim()) return code;
    }
  } catch {
    // Upstream bodies are often plain text or HTML; absence of a code is fine.
  }
  return undefined;
}

function translateTools(tools: ToolDefinition[] | undefined): OpenAIToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const strict = isStrictToolCallsEnabled();
  return tools.map((t) => {
    const parameters = strict
      ? (prepareToolSchemaForStrict(t.input_schema) as ToolDefinition['input_schema'])
      : t.input_schema;
    return {
      type: 'function',
      function: {
        name: nameToOpenAi(t.name),
        description: t.description,
        parameters,
        ...(strict ? { strict: true } : {}),
      },
    };
  });
}

function translateToolChoice(choice: LLMOptions['toolChoice']): OpenAIToolChoice {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return 'auto';
  if (choice === 'any') return 'required';
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', function: { name: nameToOpenAi(choice.name) } };
  }
  return undefined;
}

// -- Message translation: canonical (Anthropic-flavor blocks) -> OpenAI shape --
//
// Our CompletionMessage.content is `string | ContentBlock[]` where blocks are
// `text | tool_use | tool_result`. OpenAI's wire format is different:
//   - Assistant tool calls live in a separate `tool_calls` field, not `content`.
//   - Tool results become standalone `role: "tool"` messages with `tool_call_id`.
// This function flattens our canonical history into OpenAI's expected shape.
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
  tool_call_id?: string;
  /** Optional on `role: 'tool'` messages — echoes the function name the call resolved. */
  name?: string;
}

function translateMessages(messages: CompletionMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      // Strip the cache-boundary marker from the system role text (other
      // roles never carry the marker but the strip is a no-op when absent).
      const content = m.role === 'system' ? stripCacheBoundary(m.content) : m.content;
      out.push({ role: m.role, content });
      continue;
    }

    const blocks = m.content;
    if (m.role === 'assistant') {
      // Assistant: text blocks join into content; tool_use blocks become tool_calls.
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      let reasoningContent: string | undefined;
      for (const b of blocks as ContentBlock[]) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          const meta = b.providerMetadata ?? {};
          if (!reasoningContent && typeof meta['reasoningContent'] === 'string') {
            reasoningContent = meta['reasoningContent'] as string;
          }
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: {
              name: nameToOpenAi(b.name),
              arguments: JSON.stringify(b.input),
            },
          });
        }
      }
      const msg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
      };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (reasoningContent) msg.reasoning_content = reasoningContent;
      out.push(msg);
    } else if (m.role === 'user') {
      // User content blocks: text → user message; tool_result → role:"tool" message.
      const textParts: string[] = [];
      for (const b of blocks as ContentBlock[]) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            name: nameToOpenAi(b.tool_name),
            content: b.content,
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
    } else {
      // system: flatten text blocks. Strip the agent-core cache-boundary
      // marker — OpenAI doesn't have a cache_control breakpoint primitive,
      // so the marker would just be garbage text in the prompt.
      const textParts = (blocks as ContentBlock[])
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text);
      out.push({ role: 'system', content: stripCacheBoundary(textParts.join('\n')) });
    }
  }
  return out;
}

/**
 * Pull reasoning summaries out of a chat-completion message. Handles two
 * common shapes that show up via OpenAI-compatible endpoints:
 *   - DeepSeek R1 / Qwen-Thinking → `reasoning_content` (string)
 *   - OpenRouter (transparent reasoning), some Gemini wrappers → `reasoning`
 *     (string or array of {text} blocks)
 * Returns an array suitable for `LLMResponse.thinkingBlocks`.
 */
function extractReasoning(message: OpenAIResponseBody['choices'][number]['message']): string[] {
  const out: string[] = [];
  for (const raw of [message.reasoning_content, message.reasoning]) {
    if (!raw) continue;
    if (typeof raw === 'string') {
      if (raw.trim()) out.push(raw);
    } else if (Array.isArray(raw)) {
      for (const block of raw) {
        const text = block?.text;
        if (typeof text === 'string' && text.trim()) out.push(text);
      }
    }
  }
  return out;
}

/**
 * Sanitize a malformed-JSON argument string for logging.
 *
 * The raw bytes may contain control chars (DeepSeek occasionally emits
 * literal newlines / unescaped quotes inside its serialized arguments) and
 * may carry user-supplied prompt text the model copied into a tool arg. We
 * therefore:
 *   - cap the length so a 50KB hallucination doesn't blow up the log line
 *   - strip ASCII control chars (replace with U+FFFD) so log aggregators
 *     don't trip on raw \x00 / \x1b
 * No content-based redaction: by the time we get here the value is already
 * outside the secret-handling path (LLM input is not a secret store), and
 * stripping further would defeat the diagnostic purpose of this log.
 */
function sanitizeArgsForLog(raw: string): string {
  const truncated = raw.length > 500 ? `${raw.slice(0, 500)}…[+${raw.length - 500}]` : raw;
  // eslint-disable-next-line no-control-regex
  return truncated.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '�');
}

function parseToolCalls(
  raw: OpenAIToolCall[] | undefined,
  reasoningContent: string | undefined,
  providerName: string,
): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((tc) => {
    const providerMetadata = reasoningContent ? { reasoningContent } : undefined;
    // Empty / missing arguments → legitimate empty input (some tools take none).
    const argsStr = tc.function.arguments ?? '';
    if (argsStr === '') {
      return {
        id: tc.id,
        name: nameFromOpenAi(tc.function.name),
        input: {},
        ...(providerMetadata ? { providerMetadata } : {}),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsStr);
    } catch (err) {
      // Surface the failure to the agent loop instead of silently dispatching
      // with empty args. The agent can detect `_malformed_args` and treat the
      // call as a parse error rather than executing with garbage.
      log.warn(
        {
          err,
          provider: providerName,
          toolCallId: tc.id,
          toolName: nameFromOpenAi(tc.function.name),
          argsLength: argsStr.length,
        },
        'tool_call.arguments was not valid JSON; tagging _malformed_args',
      );
      // Separate ERROR-level log carrying the (truncated, sanitized) raw
      // string so we can see WHAT the model emitted next time. Kept at a
      // higher level than the WARN above because diagnosing a misbehaving
      // serializer requires the actual bytes, not just metadata.
      log.error(
        {
          provider: providerName,
          toolCallId: tc.id,
          toolName: nameFromOpenAi(tc.function.name),
          argsLength: argsStr.length,
          argsSnippet: sanitizeArgsForLog(argsStr),
        },
        'malformed tool_call arguments — capturing snippet for diagnosis',
      );
      return {
        id: tc.id,
        name: nameFromOpenAi(tc.function.name),
        input: { _malformed_args: argsStr },
        ...(providerMetadata ? { providerMetadata } : {}),
      };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        id: tc.id,
        name: nameFromOpenAi(tc.function.name),
        input: parsed as Record<string, unknown>,
        ...(providerMetadata ? { providerMetadata } : {}),
      };
    }
    log.warn(
      {
        provider: providerName,
        toolCallId: tc.id,
        parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
      },
      'tool_call.arguments JSON did not parse to an object; tagging _malformed_args',
    );
    return {
      id: tc.id,
      name: nameFromOpenAi(tc.function.name),
      input: { _malformed_args: argsStr },
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  });
}

abstract class OpenAIChatCompletionsProvider implements LLMProvider {
  readonly name: string;
  private readonly displayName: string;
  private readonly resolveKey: () => Promise<string>;
  private readonly baseUrl: string;

  protected constructor(config: {
    apiKey: string;
    apiKeyHelper?: string;
    baseUrl: string;
    providerId: string;
    providerName: string;
  }) {
    this.name = config.providerId;
    this.displayName = config.providerName;
    this.resolveKey = buildApiKeyResolver({
      staticKey: config.apiKey,
      helperCommand: config.apiKeyHelper ?? null,
    });
    this.baseUrl = config.baseUrl;
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: options.model,
      messages: translateMessages(messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    };

    const tools = translateTools(options.tools);
    if (tools) body.tools = tools;

    const toolChoice = translateToolChoice(options.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;

    // Reasoning effort — only on o1/o3/o4 and gpt-5.x; silently dropped otherwise
    if (options.thinking && getCapabilities('openai', options.model ?? '').supportsThinking) {
      body.reasoning_effort = options.thinking.effort;
    }

    const apiKey = await this.resolveKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const fetchInit: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
    if (options.signal) fetchInit.signal = options.signal;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, fetchInit);
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      throw new ProviderError(
        `${this.displayName} complete transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: this.name, cause: err },
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      const upstreamBody = errorText.slice(0, 1000);
      const kind = classifyProviderHttpError({ status: response.status });
      const retryAfterSec = parseRetryAfterSec(response.headers.get('retry-after'));
      const upstreamCode = extractUpstreamCode(errorText);
      throw new ProviderError(
        `${this.displayName} complete failed: HTTP ${response.status} ${upstreamBody.slice(0, 200)}`,
        {
          kind,
          provider: this.name,
          status: response.status,
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
          ...(upstreamCode ? { upstreamCode } : {}),
          upstreamBody,
        },
      );
    }

    const data = (await response.json()) as OpenAIResponseBody;
    const latencyMs = Date.now() - startTime;

    const firstChoice = data.choices[0]!;
    const message = firstChoice.message;
    const thinkingBlocks = extractReasoning(message);

    return {
      content: message.content ?? '',
      toolCalls: parseToolCalls(
        message.tool_calls,
        typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
        this.name,
      ),
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      model: data.model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    let response: Response;
    try {
      const apiKey = await this.resolveKey();
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      response = await fetch(`${this.baseUrl}/models`, {
        headers,
      });
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      log.warn({ err, provider: this.name, baseUrl: this.baseUrl, kind }, 'listModels transport failure');
      throw new ProviderError(
        `${this.displayName} listModels transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: this.name, cause: err },
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const kind = classifyProviderHttpError({ status: response.status });
      log.warn(
        {
          provider: this.name,
          status: response.status,
          body: body.slice(0, 200),
          baseUrl: this.baseUrl,
          kind,
        },
        'listModels failed',
      );
      throw new ProviderError(`${this.displayName} listModels failed: HTTP ${response.status} ${body.slice(0, 200)}`, {
        kind,
        provider: this.name,
        status: response.status,
        upstreamCode: extractUpstreamCode(body),
        upstreamBody: body.slice(0, 1000),
      });
    }
    const data = (await response.json()) as {
      data: Array<{ id: string; owned_by?: string }>;
    };
    const models = data.data
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({
        id: m.id,
        name: m.id,
        provider: this.name,
      }));

    return models;
  }
}

export class OpenAIProvider extends OpenAIChatCompletionsProvider {
  constructor(config: OpenAIConfig) {
    super({
      apiKey: config.apiKey,
      apiKeyHelper: config.apiKeyHelper,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      providerId: 'openai',
      providerName: 'OpenAI',
    });
  }
}

export class OpenAICompatibleProvider extends OpenAIChatCompletionsProvider {
  constructor(config: OpenAICompatibleConfig) {
    super({
      apiKey: config.apiKey,
      apiKeyHelper: config.apiKeyHelper,
      baseUrl: config.baseUrl,
      providerId: config.providerId,
      providerName: config.providerName ?? config.providerId,
    });
  }
}
