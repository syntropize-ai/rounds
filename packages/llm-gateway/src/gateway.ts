import { randomUUID, createHash } from 'node:crypto';
import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { LLMProvider, LLMOptions, LLMResponse, CompletionMessage } from './types.js';
import { ProviderError } from './types.js';
import { ProviderCapabilityError } from './providers/capabilities.js';
import {
  InMemoryAuditSink,
  type AuditEntry,
  type AuditErrorKind,
  type AuditSink,
} from './audit.js';
import { computeCostUsd } from './pricing.js';

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

  if (error instanceof Error) {
    // Network-style errors raised by fetch (no HTTP status).
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed/i.test(error.message)) {
      return { retry: true };
    }
  }
  return { retry: false };
}

/**
 * Bucket an error into a privacy-safe `AuditErrorKind`. Never propagates
 * raw error messages into the audit row — only the enum-ish kind.
 */
function classifyAuditError(error: unknown): AuditErrorKind {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (error instanceof ProviderError) {
    if (error.kind === 'auth') return 'auth';
    if (error.kind === 'unsupported') return 'unknown';
    if (error.kind === 'network') {
      if (error.status === 429) return 'ratelimit';
      if (error.status !== undefined && error.status >= 500) return 'server';
      return 'network';
    }
    return 'unknown';
  }
  if (error instanceof Error) {
    if (/timeout|ETIMEDOUT/i.test(error.message)) return 'timeout';
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i.test(error.message)) return 'network';
  }
  return 'unknown';
}

export interface GatewayConfig {
  primary: LLMProvider;
  fallback?: LLMProvider;
  /** Maximum attempts per provider. Default: 3 */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default: 200 */
  retryDelayMs?: number;
  /** Optional observer for process-local metrics. */
  metricsObserver?: LLMGatewayMetricsObserver;
  /**
   * Optional persistence sink for audit records. When omitted, an in-memory
   * sink is used (process-local, lost on restart). api-gateway injects a
   * DB-backed sink at startup.
   */
  auditSink?: AuditSink;
}

export interface TokenMetrics {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  callCount: number;
}

export interface LLMGatewayMetricsObserver {
  recordSuccess?(event: {
    provider: string;
    model: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): void;
  recordFailure?(event: {
    provider: string;
    model: string;
    latencyMs: number;
    error: string;
  }): void;
}

/**
 * Optional per-call audit context — orgId / userId / sessionId. Forwarded
 * straight into the audit row so DB-backed sinks can attribute calls. Never
 * carries content; only identifiers.
 */
export interface AuditContext {
  orgId?: string;
  userId?: string;
  sessionId?: string;
}

export class LLMGateway {
  private readonly primary: LLMProvider;
  private readonly fallback: LLMProvider | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly metricsObserver: LLMGatewayMetricsObserver | undefined;
  private metrics: TokenMetrics;
  private readonly auditSink: AuditSink;
  /**
   * In-memory tee retained for backward compatibility with `getAuditLog()`
   * callers (admin UIs, tests). Always populated regardless of the
   * configured persistence sink.
   */
  private readonly auditMemory = new InMemoryAuditSink();

  constructor(config: GatewayConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 200;
    this.metricsObserver = config.metricsObserver;
    this.auditSink = config.auditSink ?? this.auditMemory;
    this.metrics = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      callCount: 0,
    };
  }

  async complete(
    messages: CompletionMessage[],
    options: LLMOptions,
    auditContext?: AuditContext,
  ): Promise<LLMResponse> {
    // Full sha256 digest — NOT truncated. Audit rows persist this so
    // operators can correlate identical prompt shapes across calls without
    // ever storing the prompt text itself.
    const promptHash = createHash('sha256')
      .update(JSON.stringify(messages))
      .digest('hex');

    const startTime = Date.now();

    try {
      const response = await this.callWithRetry(this.primary, messages, options);
      await this.recordSuccess(response, promptHash, this.primary.name, startTime, auditContext);
      return response;
    } catch (primaryError) {
      if (this.fallback) {
        try {
          const response = await this.callWithRetry(this.fallback, messages, options);
          await this.recordSuccess(response, promptHash, this.fallback.name, startTime, auditContext);
          return response;
        } catch (fallbackError) {
          await this.recordFailure(promptHash, this.fallback.name, startTime, fallbackError, auditContext);
          throw fallbackError;
        }
      }
      await this.recordFailure(promptHash, this.primary.name, startTime, primaryError, auditContext);
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

  private async recordSuccess(
    response: LLMResponse,
    promptHash: string,
    providerName: string,
    startTime: number,
    auditContext?: AuditContext,
  ): Promise<void> {
    const latencyMs = Date.now() - startTime;
    this.metrics.totalPromptTokens += response.usage.promptTokens;
    this.metrics.totalCompletionTokens += response.usage.completionTokens;
    this.metrics.totalTokens += response.usage.totalTokens;
    this.metrics.callCount++;

    const costUsd = computeCostUsd(
      response.model,
      response.usage.promptTokens,
      response.usage.completionTokens,
    );

    const entry: AuditEntry = {
      id: randomUUID(),
      requestedAt: new Date(startTime).toISOString(),
      provider: providerName,
      model: response.model,
      promptHash,
      inputTokens: response.usage.promptTokens,
      outputTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      cachedTokens: null,
      costUsd,
      latencyMs,
      success: true,
      errorKind: null,
      abortReason: null,
      orgId: auditContext?.orgId ?? null,
      userId: auditContext?.userId ?? null,
      sessionId: auditContext?.sessionId ?? null,
    };
    await this.persistAudit(entry);

    this.metricsObserver?.recordSuccess?.({
      provider: providerName,
      model: response.model,
      latencyMs,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    });
  }

  private async recordFailure(
    promptHash: string,
    providerName: string,
    startTime: number,
    error: unknown,
    auditContext?: AuditContext,
  ): Promise<void> {
    const latencyMs = Date.now() - startTime;
    const errorKind = classifyAuditError(error);
    // Keep the metrics observer's free-text `error` field for in-process
    // metrics dashboards, but never let it leak into the audit row.
    const message = getErrorMessage(error);

    const entry: AuditEntry = {
      id: randomUUID(),
      requestedAt: new Date(startTime).toISOString(),
      provider: providerName,
      model: 'unknown',
      promptHash,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: null,
      costUsd: null,
      latencyMs,
      success: false,
      errorKind,
      abortReason: errorKind === 'aborted' ? 'caller_disconnect' : null,
      orgId: auditContext?.orgId ?? null,
      userId: auditContext?.userId ?? null,
      sessionId: auditContext?.sessionId ?? null,
    };
    await this.persistAudit(entry);

    this.metricsObserver?.recordFailure?.({
      provider: providerName,
      model: 'unknown',
      latencyMs,
      error: message,
    });
  }

  /**
   * Write to the configured persistence sink AND mirror into the in-memory
   * tee for legacy `getAuditLog()` consumers. Sink errors are swallowed —
   * an audit-write failure must never break a live LLM call.
   */
  private async persistAudit(entry: AuditEntry): Promise<void> {
    // Mirror unconditionally so getAuditLog() works even when a custom sink
    // was injected.
    if (this.auditSink !== this.auditMemory) {
      await this.auditMemory.record(entry);
    }
    try {
      await this.auditSink.record(entry);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'audit sink failed — entry dropped',
      );
    }
  }

  getMetrics(): TokenMetrics {
    return { ...this.metrics };
  }

  getAuditLog(): readonly AuditEntry[] {
    return this.auditMemory.getEntries();
  }
}
