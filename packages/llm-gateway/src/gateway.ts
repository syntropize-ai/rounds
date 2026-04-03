import { randomUUID, createHash } from 'node:crypto';
import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage } from './types.js';
import { AuditLogger, type AuditEntry } from './audit.js';

export interface GatewayConfig {
  primary: LLMProvider;
  fallback?: LLMProvider;
  /** Maximum attempts per provider. Default: 3 */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default: 200 */
  retryDelayMs?: number;
}

export interface TokenMetrics {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  callCount: number;
}

export class LLMGateway {
  private readonly primary: LLMProvider;
  private readonly fallback: LLMProvider | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private metrics: TokenMetrics;
  private readonly audit = new AuditLogger();

  constructor(config: GatewayConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 200;
    this.metrics = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      callCount: 0,
    };
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const promptHash = createHash('sha256')
      .update(JSON.stringify(messages))
      .digest('hex')
      .slice(0, 16);

    const startTime = Date.now();

    try {
      const response = await this.callWithRetry(this.primary, messages, options);
      this.recordSuccess(response, promptHash, this.primary.name, startTime);
      return response;
    } catch (primaryError) {
      if (this.fallback) {
        try {
          const response = await this.callWithRetry(this.fallback, messages, options);
          this.recordSuccess(response, promptHash, this.fallback.name, startTime);
          return response;
        } catch (fallbackError) {
          this.recordFailure(promptHash, this.fallback.name, startTime, fallbackError);
          throw fallbackError;
        }
      }
      this.recordFailure(promptHash, this.primary.name, startTime, primaryError);
      throw primaryError;
    }
  }

  private async callWithRetry(
    provider: LLMProvider,
    messages: CompletionMessage[],
    options: LLMOptions,
  ): Promise<LLMResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await provider.complete(messages, options);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.retryDelayMs * Math.pow(2, attempt)),
          );
        }
      }
    }
    throw lastError;
  }

  private recordSuccess(
    response: LLMResponse,
    promptHash: string,
    providerName: string,
    startTime: number,
  ): void {
    const latencyMs = Date.now() - startTime;
    this.metrics.totalPromptTokens += response.usage.promptTokens;
    this.metrics.totalCompletionTokens += response.usage.completionTokens;
    this.metrics.totalTokens += response.usage.totalTokens;
    this.metrics.callCount++;

    this.audit.record({
      id: randomUUID(),
      timestamp: new Date(),
      provider: providerName,
      model: response.model,
      promptHash,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      latencyMs,
      success: true,
    });
  }

  private recordFailure(
    promptHash: string,
    providerName: string,
    startTime: number,
    error: unknown,
  ): void {
    const latencyMs = Date.now() - startTime;
    this.audit.record({
      id: randomUUID(),
      timestamp: new Date(),
      provider: providerName,
      model: 'unknown',
      promptHash,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  getMetrics(): TokenMetrics {
    return { ...this.metrics };
  }

  getAuditLog(): readonly AuditEntry[] {
    return this.audit.getEntries();
  }
}
