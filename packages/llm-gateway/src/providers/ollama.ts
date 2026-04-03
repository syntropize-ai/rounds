import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage, ModelInfo } from '../types.js';

export interface OllamaConfig {
  baseUrl?: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    details: {
      parameter_size?: string;
      family?: string;
      format?: string;
    };
  }>;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    const model = options.model ?? 'llama3.1';

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
      },
    };

    if (options.responseFormat === 'json') {
      body['format'] = 'json';
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const latencyMs = Date.now() - startTime;

    return {
      content: data.message.content,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      model: data.model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) return [];

    const data = (await response.json()) as OllamaTagsResponse;
    return data.models.map((m) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama',
      description: [m.details.family, m.details.parameter_size].filter(Boolean).join(' · '),
    }));
  }
}
