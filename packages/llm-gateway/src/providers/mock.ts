import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage } from '../types.js';
import { ProviderError, type ProviderErrorKind } from '../types.js';

export interface MockProviderConfig {
  name?: string;
  response?: Partial<LLMResponse>;
  shouldFail?: boolean;
  failMessage?: string;
  /**
   * If set, the mock throws a `ProviderError` with this `kind` instead of a
   * plain `Error`. Lets tests exercise the gateway's retry classification
   * (e.g. `'network'` to trigger retry, `'auth'` to fail fast).
   */
  failKind?: ProviderErrorKind;
  latencyMs?: number;
}

export class MockProvider implements LLMProvider {
  readonly name: string;
  private mockResponse: Partial<LLMResponse>;
  private shouldFail: boolean;
  private failMessage: string;
  private failKind?: ProviderErrorKind;
  private mockLatencyMs: number;
  callCount = 0;

  constructor(config: MockProviderConfig = {}) {
    this.name = config.name ?? 'mock';
    this.mockResponse = config.response ?? {};
    this.shouldFail = config.shouldFail ?? false;
    this.failMessage = config.failMessage ?? 'Mock provider error';
    if (config.failKind) this.failKind = config.failKind;
    this.mockLatencyMs = config.latencyMs ?? 0;
  }

  async complete(_messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    this.callCount++;

    if (this.mockLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.mockLatencyMs));
    }

    if (this.shouldFail) {
      if (this.failKind) {
        throw new ProviderError(this.failMessage, {
          kind: this.failKind,
          provider: this.name,
        });
      }
      throw new Error(this.failMessage);
    }

    return {
      content: this.mockResponse.content ?? 'Mock response content',
      toolCalls: this.mockResponse.toolCalls ?? [],
      usage: this.mockResponse.usage ?? {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      model: this.mockResponse.model ?? options.model ?? 'mock-model',
      latencyMs: this.mockResponse.latencyMs ?? this.mockLatencyMs,
    };
  }

  setFailing(shouldFail: boolean, message?: string): void {
    this.shouldFail = shouldFail;
    if (message !== undefined) {
      this.failMessage = message;
    }
  }

  reset(): void {
    this.callCount = 0;
    this.shouldFail = false;
  }
}
