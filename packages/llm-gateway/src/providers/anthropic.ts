import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage, ModelInfo } from '../types.js';

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

interface AnthropicResponseBody {
  content: Array<{
    type: string;
    text: string;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;
  stop_reason: string | null;
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

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify({
        model: options.model,
        system: systemParts.length > 0 ? systemParts.map((m) => m.content).join('\n') : undefined,
        messages: conversationParts,
        temperature: options.temperature,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as AnthropicResponseBody;
    const latencyMs = Date.now() - startTime;

    if (!data.content || data.content.length === 0) {
      return {
        content: '',
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
        model: data.model,
        latencyMs,
      };
    }

    const firstBlock = data.content[0];
    if (!firstBlock || firstBlock.type !== 'text') {
      return {
        content: '',
        usage: {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        },
        model: data.model,
        latencyMs,
      };
    }

    // If output was truncated due to max_tokens, throw so callers can retry with higher limit
    if (data.stop_reason === 'max_tokens' && options.responseFormat === 'json') {
      throw new Error(
        `Response truncated at ${data.usage.input_tokens + data.usage.output_tokens} tokens — output is likely incomplete JSON. Consider increasing maxTokens.`,
      );
    }

    return {
      content: firstBlock.text,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      model: data.model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.apiVersion },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { data: Array<{ id: string; display_name?: string }> };
    return data.data.map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      provider: 'anthropic',
    }));
  }
}
