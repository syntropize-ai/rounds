import { createLogger } from '@agentic-obs/common/logging';
import type {
  LLMProvider,
  LLMOptions,
  LLMResponse,
  CompletionMessage,
  ContentBlock,
  ModelInfo,
  ToolCall,
} from '../types.js';
import { ProviderError, classifyProviderHttpError } from '../types.js';
import { effortToBudgetTokens, getCapabilities, type SamplingParam } from './capabilities.js';
import { buildApiKeyResolver } from '../api-key-helper.js';

const log = createLogger('anthropic-provider');

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_API_VERSION = '2023-06-01';

/**
 * Endpoint flavor — controls the URL template and (for Bedrock) the body
 * shape. 'native' = api.anthropic.com style; 'bedrock' = AWS Bedrock proxy
 * shape (POST /model/{model}/invoke + anthropic_version body field).
 */
export type AnthropicEndpointFlavor = 'native' | 'bedrock';

export interface AnthropicConfig {
  /** Static API key. Empty / null is allowed — useful for corp gateways
   *  that authenticate via a network boundary instead of a header. When
   *  empty, no `x-api-key` header is sent. */
  apiKey: string;
  /** Shell command that prints a fresh API key on stdout. Wins over apiKey
   *  when set; the gateway invokes it (with a 5-min TTL cache) before each
   *  request. Resulting empty string also skips the auth header. */
  apiKeyHelper?: string;
  baseUrl?: string;
  apiType?: 'api-key' | 'bearer';
  apiVersion?: string;
  cacheControl?: boolean;
  /** 'native' (default) → POST /v1/messages; 'bedrock' → POST
   *  /model/{model}/invoke with `anthropic_version: bedrock-2023-05-31` in
   *  the body. Used when an Anthropic-shape gateway sits in front of
   *  Bedrock. */
  endpointFlavor?: AnthropicEndpointFlavor;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | { type: string };

interface AnthropicResponseBody {
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;
  stop_reason: string | null;
}

type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | undefined;

function buildToolChoice(toolChoice: LLMOptions['toolChoice']): AnthropicToolChoice {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'any') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
    return { type: 'tool', name: toolChoice.name };
  }
  return undefined;
}

function isTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
  return block.type === 'text' && typeof (block as AnthropicTextBlock).text === 'string';
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return (
    block.type === 'tool_use' &&
    typeof (block as AnthropicToolUseBlock).id === 'string' &&
    typeof (block as AnthropicToolUseBlock).name === 'string'
  );
}

function isThinkingBlock(block: AnthropicContentBlock): block is AnthropicThinkingBlock {
  return block.type === 'thinking' && typeof (block as AnthropicThinkingBlock).thinking === 'string';
}

// ── Wire translation ──────────────────────────────────────────────────────
//
// The gateway's internal `ContentBlock` is a superset designed to round-trip
// across all providers (it carries fields like `tool_name` that OpenAI /
// Gemini's wire shapes need on tool_result). The Anthropic wire is stricter —
// Bedrock in particular rejects unknown fields with
// `ValidationException: Extra inputs are not permitted`. Every block that
// leaves this provider goes through these explicit rebuilds, so adding a new
// internal field never silently leaks onto the Anthropic wire.

interface AnthropicToolResultWireBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthropicWireBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | AnthropicToolResultWireBlock
  | { type: 'thinking'; thinking: string; signature?: string };

interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicWireBlock[];
}

function toAnthropicWireBlock(b: ContentBlock): AnthropicWireBlock {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result': {
      // Deliberately drop `tool_name` — the Anthropic wire has no such field.
      // tool_result is correlated to its tool_use purely via `tool_use_id`.
      const out: AnthropicToolResultWireBlock = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
      };
      if (b.is_error !== undefined) out.is_error = b.is_error;
      return out;
    }
  }
}

function toAnthropicWireMessage(m: CompletionMessage): AnthropicWireMessage {
  // Anthropic only accepts user/assistant in the messages array; system is
  // hoisted out by the caller. Anything else here is a programmer error.
  if (m.role !== 'user' && m.role !== 'assistant') {
    throw new Error(`toAnthropicWireMessage: unexpected role "${m.role}"`);
  }
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  return { role: m.role, content: m.content.map(toAnthropicWireBlock) };
}

/**
 * Pick the sampling knobs the model accepts. Returns an object spread-ready
 * for the request body — keys absent from the result must NOT appear on the
 * wire (some upstreams treat presence-with-undefined as a validation error).
 */
function pickSamplingParams(
  options: LLMOptions,
  allowed: ReadonlySet<SamplingParam>,
): { temperature?: number; top_p?: number; top_k?: number } {
  const out: { temperature?: number; top_p?: number; top_k?: number } = {};
  if (allowed.has('temperature') && options.temperature !== undefined) {
    out.temperature = options.temperature;
  }
  // top_p / top_k aren't on LLMOptions today; reserved for future without
  // having to re-touch this site.
  return out;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly resolveKey: () => Promise<string>;
  private readonly baseUrl: string;
  private readonly cacheControl: boolean;
  private readonly apiVersion: string;
  private readonly endpointFlavor: AnthropicEndpointFlavor;

  constructor(private readonly config: AnthropicConfig) {
    this.resolveKey = buildApiKeyResolver({
      staticKey: config.apiKey,
      helperCommand: config.apiKeyHelper ?? null,
    });
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.cacheControl = config.cacheControl ?? false;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.endpointFlavor = config.endpointFlavor ?? 'native';
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();

    // Anthropic separates system messages from the messages array
    const systemParts = messages.filter((m) => m.role === 'system');
    const conversationParts = messages.filter((m) => m.role !== 'system');

    const tools = options.tools && options.tools.length > 0 ? options.tools : undefined;
    const toolChoice = tools ? buildToolChoice(options.toolChoice) : undefined;

    // System message is always plain text in our usage; if a caller ever
    // passed blocks, flatten the text blocks to preserve compatibility.
    const flattenContent = (c: CompletionMessage['content']): string => {
      if (typeof c === 'string') return c;
      return c.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n');
    };

    const capabilities = getCapabilities('anthropic', options.model ?? '');
    const sampling = pickSamplingParams(options, capabilities.samplingParams);

    const requestBody: Record<string, unknown> = {
      model: options.model,
      system: systemParts.length > 0 ? systemParts.map((m) => flattenContent(m.content)).join('\n') : undefined,
      // Translate to Anthropic wire shape. Internal ContentBlock carries
      // fields (e.g. tool_result.tool_name) that other providers need but
      // Anthropic/Bedrock reject as "Extra inputs". Whitelisting here is the
      // single chokepoint that keeps internal shape from leaking out.
      messages: conversationParts.map(toAnthropicWireMessage),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...sampling,
    };
    if (tools) {
      requestBody.tools = tools;
      if (toolChoice) {
        requestBody.tool_choice = toolChoice;
      }
    }

    // Extended thinking — only attach when the model supports it. Anthropic
    // requires temperature=1 when thinking is enabled, so we override here
    // (only when the model actually accepts a temperature knob; otherwise
    // the API uses its own implicit value).
    if (options.thinking && capabilities.supportsThinking) {
      const budget = effortToBudgetTokens(options.thinking.effort);
      requestBody.thinking = { type: 'enabled', budget_tokens: budget };
      if (capabilities.samplingParams.has('temperature')) {
        requestBody.temperature = 1;
      } else {
        delete requestBody.temperature;
      }
      // budget_tokens must be < max_tokens; bump max_tokens if needed
      const currentMax = (requestBody.max_tokens as number) ?? DEFAULT_MAX_TOKENS;
      if (currentMax <= budget) {
        requestBody.max_tokens = budget + DEFAULT_MAX_TOKENS;
      }
    }

    // Bedrock gates Anthropic models behind /model/{id}/invoke and requires
    // `anthropic_version` in the body (instead of the header). The `model`
    // travels in the URL path, not the body.
    let url: string;
    if (this.endpointFlavor === 'bedrock') {
      const modelId = encodeURIComponent(String(options.model ?? ''));
      url = `${this.baseUrl}/model/${modelId}/invoke`;
      requestBody.anthropic_version = 'bedrock-2023-05-31';
      delete requestBody.model;
    } else {
      url = `${this.baseUrl}/v1/messages`;
    }

    // Resolve the API key per-call so apiKeyHelper rotations land without
    // restarting the process. Empty result → don't send the header at all
    // (some corp gateways authenticate at the network boundary).
    const apiKey = await this.resolveKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': this.apiVersion,
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const fetchInit: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    };
    if (options.signal) fetchInit.signal = options.signal;
    let response: Response;
    try {
      response = await fetch(url, fetchInit);
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      throw new ProviderError(
        `Anthropic complete transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: this.name, cause: err },
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      const kind = classifyProviderHttpError({ status: response.status });
      throw new ProviderError(
        `Anthropic complete failed: HTTP ${response.status} ${errorText.slice(0, 200)}`,
        {
          kind,
          provider: this.name,
          status: response.status,
          upstreamBody: errorText.slice(0, 1000),
        },
      );
    }

    const data = (await response.json()) as AnthropicResponseBody;
    const latencyMs = Date.now() - startTime;

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const usage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    };

    const blocks: AnthropicContentBlock[] = Array.isArray(data.content) ? data.content : [];

    const textPieces: string[] = [];
    const toolCalls: ToolCall[] = [];
    const thinkingBlocks: string[] = [];
    for (const block of blocks) {
      if (isTextBlock(block)) {
        textPieces.push(block.text);
      } else if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      } else if (isThinkingBlock(block)) {
        thinkingBlocks.push(block.thinking);
      }
    }

    return {
      content: textPieces.join('\n'),
      toolCalls,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      usage,
      model: data.model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    let response: Response;
    try {
      const apiKey = await this.resolveKey();
      const headers: Record<string, string> = { 'anthropic-version': this.apiVersion };
      if (apiKey) headers['x-api-key'] = apiKey;
      response = await fetch(`${this.baseUrl}/v1/models`, { headers });
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      log.warn({ err, provider: 'anthropic', baseUrl: this.baseUrl, kind }, 'listModels transport failure');
      throw new ProviderError(
        `Anthropic listModels transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: 'anthropic', cause: err },
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const kind = classifyProviderHttpError({ status: response.status });
      log.warn(
        { provider: 'anthropic', status: response.status, body: body.slice(0, 200), baseUrl: this.baseUrl, kind },
        'listModels failed',
      );
      throw new ProviderError(
        `Anthropic listModels failed: HTTP ${response.status} ${body.slice(0, 200)}`,
        { kind, provider: 'anthropic', status: response.status },
      );
    }
    const data = (await response.json()) as { data: Array<{ id: string; display_name?: string }> };
    return data.data.map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      provider: 'anthropic',
    }));
  }
}
