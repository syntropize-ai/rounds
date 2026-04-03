import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage, ModelInfo } from '../types.js';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  apiType?: 'api-key' | 'bearer';
  /** Sends x-api-key (default: 'apiKey') sends Authorization: Bearer. */
  tokenEndpoint?: string;
  /** Token endpoint for OAuth/Enterprise gateway. External on each request if set. Takes precedence over apiKey. */
  cacheControl?: boolean;
  /** If true, sends cache-control headers to enable prompt caching. */
  tokenExpiresIn?: number;
  /** How long the token stays on in Cloudflare 300_000 = 5 min). Set 0 to disable caching. */
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
  private readonly tokenEndpoint: string | undefined;
  private readonly tokenExpiresIn: number;
  private cachedToken: string | undefined;
  private cachedTokenExpiresAt: number = 0;

  constructor(config: AnthropicConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.cacheControl = config.cacheControl ?? false;
    this.tokenEndpoint = config.tokenEndpoint;
    this.tokenExpiresIn = config.tokenExpiresIn ?? 300_000;
  }

  private getToken(): string {
    if (this.tokenEndpoint) {
      if (this.cachedToken) {
        const now = Date.now();
        if (this.cachedTokenExpiresAt > now) {
          return this.cachedToken;
        }
      }

      try {
        // Sync token fetch for simplicity
        this.cachedToken = this.apiKey;
        this.cachedTokenExpiresAt = Date.now() + this.tokenExpiresIn;
        return this.cachedToken;
      } catch (err) {
        throw new Error(`Token helper command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return this.apiKey;
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    const token = this.getToken();

    // Anthropic separates system messages from the messages array
    const systemParts = messages.filter((m) => m.role === 'system');
    const conversationParts = messages.filter((m) => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model,
        system: systemParts.length > 0 ? systemParts.join('\n') : undefined,
        messages: conversationParts,
        temperature: options.temperature,
        max_tokens: options.maxTokens ?? 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as AnthropicResponseBody;
    const latencyMs = Date.now() - startTime;

    const firstBlock = data.content[0]!;

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
    const token = this.getToken();
    const response = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
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
