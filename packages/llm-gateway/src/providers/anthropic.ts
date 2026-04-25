import { createLogger } from '@agentic-obs/common/logging';
import type {
  LLMProvider,
  LLMOptions,
  LLMResponse,
  CompletionMessage,
  ModelInfo,
  ToolCall,
} from '../types.js';

const log = createLogger('anthropic-provider');

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_API_VERSION = '2023-06-01';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  apiType?: 'api-key' | 'bearer';
  /** Sends x-api-key (default: 'apiKey') sends Authorization: Bearer. */
  apiVersion?: string;
  /** Anthropic API version header. Defaults to DEFAULT_API_VERSION. */
  cacheControl?: boolean;
  /** If true, sends cache-control headers to enable prompt caching. */
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

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

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

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cacheControl: boolean;
  private readonly apiVersion: string;

  constructor(private readonly config: AnthropicConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.cacheControl = config.cacheControl ?? false;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
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
    const requestBody: Record<string, unknown> = {
      model: options.model,
      system: systemParts.length > 0 ? systemParts.map((m) => flattenContent(m.content)).join('\n') : undefined,
      // Conversation messages pass through as-is. Anthropic's API natively
      // accepts content as either a string or an array of {type:'text'|'tool_use'|'tool_result'}
      // blocks, which exactly matches our ContentBlock shape — no translation needed.
      messages: conversationParts,
      temperature: options.temperature,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (tools) {
      requestBody.tools = tools;
      if (toolChoice) {
        requestBody.tool_choice = toolChoice;
      }
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
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
    for (const block of blocks) {
      if (isTextBlock(block)) {
        textPieces.push(block.text);
      } else if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      }
    }

    return {
      content: textPieces.join('\n'),
      toolCalls,
      usage,
      model: data.model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.apiVersion },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn(
          { provider: 'anthropic', status: response.status, body: body.slice(0, 200), baseUrl: this.baseUrl },
          'listModels failed',
        );
        return [];
      }
      const data = (await response.json()) as { data: Array<{ id: string; display_name?: string }> };
      return data.data.map((m) => ({
        id: m.id,
        name: m.display_name ?? m.id,
        provider: 'anthropic',
      }));
    } catch (err) {
      log.warn({ err, provider: 'anthropic', baseUrl: this.baseUrl }, 'listModels failed');
      return [];
    }
  }
}
