import { randomUUID, createHash } from 'node:crypto';
import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage } from './types.js';
import { ProviderError } from './types.js';
import { ProviderCapabilityError } from './providers/capabilities.js';
import { AuditLogger, type AuditEntry } from './audit.js';

const log = createLogger('llm-gateway');

/**
 * Decide whether `error` warrants another retry. Default to false (fail fast)
 * unless the error class clearly indicates a transient condition. Returning
 * { retry: true, delayMs } lets the caller honor an upstream Retry-After.
 */
function shouldRetryError(error: unknown): { retry: boolean; delayMs?: number } {
  // ProviderCapabilityError is a hard "this model can't do that" — never retry.
  if (error instanceof ProviderCapabilityError) return { retry: false };

  if (error instanceof ProviderError) {
    if (error.kind === 'auth' || error.kind === 'unsupported') return { retry: false };
    if (error.kind === 'network') {
      const result: { retry: boolean; delayMs?: number } = { retry: true };
      if (error.retryAfterSec !== undefined) {
        result.delayMs = error.retryAfterSec * 1000;
      }
      return result;
    }
    // 'unknown' — fail fast. Better to surface a novel error than spin.
    return { retry: false };
  }

  // Provider `complete` methods throw raw `Error` with the
  // "${Provider} API error ${status}: ${body}" shape. Parse the status so
  // we can classify here too — the same retry policy applies.
  if (error instanceof Error) {
    const m = error.message.match(/API error (\d+)\b/i);
    if (m) {
      const status = Number(m[1]);
      if (status === 429) {
        const result: { retry: boolean; delayMs?: number } = { retry: true };
        const retryHeader = error.message.match(/retry-after[^0-9]*(\d+)/i);
        if (retryHeader) result.delayMs = Number(retryHeader[1]) * 1000;
        return result;
      }
      if (status >= 500) return { retry: true };
      // 4xx (except 429) → don't retry.
      if (status >= 400) return { retry: false };
    }
    // Network-style errors raised by fetch (no HTTP status).
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed/i.test(error.message)) {
      return { retry: true };
    }
  }
  return { retry: false };
}

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
      // Honor caller-supplied AbortSignal at the top of every iteration so
      // disconnects don't waste another attempt.
      if (options.signal?.aborted) {
        const abortErr = new Error('LLM call aborted by caller');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      try {
        return await provider.complete(messages, options);
      } catch (error) {
        lastError = error;
        // AbortError → never retry; bubble immediately.
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        const decision = shouldRetryError(error);
        if (!decision.retry) {
          // Non-retryable: bail immediately so we don't hammer a provider that
          // has already given a definitive 4xx / capability rejection.
          log.warn(
            {
              provider: provider.name,
              attempt: attempt + 1,
              err: error instanceof Error ? error.message : String(error),
              errKind: error instanceof ProviderError ? error.kind : 'unclassified',
            },
            'callWithRetry: non-retryable error, aborting',
          );
          throw error;
        }
        if (attempt < this.maxRetries - 1) {
          const baseDelay = this.retryDelayMs * Math.pow(2, attempt);
          // Honor upstream Retry-After hint, but cap so a malicious / buggy
          // header can't pin us indefinitely.
          const delayMs =
            decision.delayMs !== undefined
              ? Math.min(decision.delayMs, 30_000)
              : baseDelay;
          log.info(
            { provider: provider.name, attempt: attempt + 1, delayMs },
            'callWithRetry: retrying after transient error',
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      error: getErrorMessage(error),
    });
  }

  getMetrics(): TokenMetrics {
    return { ...this.metrics };
  }

  getAuditLog(): readonly AuditEntry[] {
    return this.audit.getEntries();
  }
}
