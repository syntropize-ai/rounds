import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage, ModelInfo } from '../types.js';

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
}

interface GeminiCandidate {
  content: { parts: Array<{ text: string }> };
}

interface GeminiResponseBody {
  candidates: GeminiCandidate[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion: string;
}

interface GeminiModelsResponse {
  models: Array<{
    name: string;
    displayName: string;
    description?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: GeminiConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    const model = options.model ?? 'gemini-2.5-flash';

    // Convert messages to Gemini format
    const systemParts = messages.filter((m) => m.role === 'system');
    const conversationParts = messages.filter((m) => m.role !== 'system');

    const contents = conversationParts.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };

    if (systemParts.length > 0) {
      body['systemInstruction'] = {
        parts: [{ text: systemParts.map((s) => s.content).join('\n') }],
      };
    }

    body['generationConfig'] = {
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
      ...(options.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
    };

    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponseBody;
    const latencyMs = Date.now() - startTime;

    const firstCandidate = data.candidates[0]!;
    const text = firstCandidate.content.parts.map((p) => p.text).join('');

    return {
      content: text,
      usage: {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      },
      model: data.modelVersion ?? model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(
      `${this.baseUrl}/v1beta/models?key=${this.apiKey}`,
    );
    if (!response.ok) return [];

    const data = (await response.json()) as GeminiModelsResponse;
    return data.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({
        id: m.name.replace('models/', ''),
        name: m.displayName,
        provider: 'gemini',
        contextWindow: m.inputTokenLimit,
        description: m.description,
      }));
  }
}
