import { describe, it, expect } from 'vitest';
import { LLMGateway } from '../gateway.js';
import { MockProvider } from '../providers/mock.js';
import { InMemoryAuditSink, type AuditEntry, type AuditSink } from '../audit.js';
import { _resetPricingWarnCacheForTests } from '../pricing.js';

describe('LLMGateway', () => {
  it('should complete with primary provider', async () => {
    const primary = new MockProvider({ name: 'primary' });
    const gateway = new LLMGateway({ primary });

    const result = await gateway.complete(
      [{ role: 'user', content: 'Hello' }],
      { model: 'test' },
    );

    expect(result.content).toBe('Mock response content');
    expect(primary.callCount).toBe(1);
  });

  it('should fall back to secondary on primary failure', async () => {
    const primary = new MockProvider({ name: 'primary', shouldFail: true });
    const fallback = new MockProvider({ name: 'fallback', response: { content: 'Fallback response' } });
    const gateway = new LLMGateway({ primary, fallback, maxRetries: 1 });

    const result = await gateway.complete(
      [{ role: 'user', content: 'Hello' }],
      { model: 'test' },
    );

    expect(result.content).toBe('Fallback response');
    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(1);
  });

  it('retries on transient (network-kind) ProviderError up to maxRetries', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failKind: 'server_error',
      failMessage: 'Mock provider error',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('Mock provider error');

    // network-kind → retried 3 times.
    expect(primary.callCount).toBe(3);
  });

  it('does NOT retry auth-kind ProviderError — fails fast', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failKind: 'auth_failure',
      failMessage: 'API key invalid',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('API key invalid');

    // auth-kind is non-retryable — should be hit exactly once.
    expect(primary.callCount).toBe(1);
  });

  it('does NOT retry unsupported-kind ProviderError', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failKind: 'not_found',
      failMessage: 'feature not supported',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('feature not supported');

    expect(primary.callCount).toBe(1);
  });

  it('does NOT retry raw HTTP-shaped Error from provider', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failMessage: 'OpenAI API error 503: upstream',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('503');

    // Providers must throw typed ProviderError for HTTP retry semantics.
    expect(primary.callCount).toBe(1);
  });

  it('retries raw network-style Error from provider', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failMessage: 'fetch failed: ECONNRESET',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('ECONNRESET');

    expect(primary.callCount).toBe(3);
  });

  it('should track metrics', async () => {
    const primary = new MockProvider();
    const gateway = new LLMGateway({ primary });

    await gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' });
    await gateway.complete([{ role: 'user', content: 'World' }], { model: 'test' });

    const metrics = gateway.getMetrics();
    expect(metrics.callCount).toBe(2);
    expect(metrics.totalTokens).toBe(60);
  });

  it('should record audit entries', async () => {
    const primary = new MockProvider();
    const gateway = new LLMGateway({ primary });

    await gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' });

    const audit = gateway.getAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.success).toBe(true);
    expect(audit[0]!.provider).toBe('mock');
  });

  it('persists success entries to a custom AuditSink with token counts and latency', async () => {
    const primary = new MockProvider();
    const sink = new InMemoryAuditSink();
    const gateway = new LLMGateway({ primary, auditSink: sink });

    await gateway.complete(
      [{ role: 'user', content: 'Hello' }],
      { model: 'test' },
      { orgId: 'org_main', userId: 'u1', sessionId: 's1' },
    );

    const entries = sink.getEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.success).toBe(true);
    expect(e.inputTokens).toBe(10);
    expect(e.outputTokens).toBe(20);
    expect(e.totalTokens).toBe(30);
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
    expect(e.orgId).toBe('org_main');
    expect(e.userId).toBe('u1');
    expect(e.sessionId).toBe('s1');
    expect(e.errorKind).toBeNull();
  });

  it('persists failure entries with success=false and errorKind set', async () => {
    const primary = new MockProvider({
      shouldFail: true,
      failKind: 'auth_failure',
      failMessage: 'API key invalid',
    });
    const sink = new InMemoryAuditSink();
    const gateway = new LLMGateway({ primary, auditSink: sink, maxRetries: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow();

    const entries = sink.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.success).toBe(false);
    expect(entries[0]!.errorKind).toBe('auth');
  });

  it('computes cost_usd for a known model', async () => {
    _resetPricingWarnCacheForTests();
    const primary = new MockProvider({
      response: {
        model: 'claude-sonnet-4-5',
        usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      },
    });
    const sink = new InMemoryAuditSink();
    const gateway = new LLMGateway({ primary, auditSink: sink });

    await gateway.complete([{ role: 'user', content: 'Hi' }], { model: 'claude-sonnet-4-5' });

    const e = sink.getEntries()[0]!;
    // sonnet-4-5 = $3 in / $15 out per 1M tokens => $18 for 1M+1M.
    expect(e.costUsd).not.toBeNull();
    expect(e.costUsd).toBeCloseTo(18, 6);
  });

  it('returns cost_usd = null for unknown models without throwing', async () => {
    _resetPricingWarnCacheForTests();
    const primary = new MockProvider({
      response: {
        model: 'totally-fictional-model-9000',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    const sink = new InMemoryAuditSink();
    const gateway = new LLMGateway({ primary, auditSink: sink });

    await gateway.complete([{ role: 'user', content: 'Hi' }], { model: 'whatever' });

    expect(sink.getEntries()[0]!.costUsd).toBeNull();
  });

  it('NEVER stores raw prompt text or user message content in audit rows', async () => {
    const primary = new MockProvider();
    const sink = new InMemoryAuditSink();
    const gateway = new LLMGateway({ primary, auditSink: sink });

    const SECRET_PROMPT = 'sk-supersecret-please-do-not-leak-this-value-12345';
    await gateway.complete(
      [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: SECRET_PROMPT },
      ],
      { model: 'test' },
    );

    const entry = sink.getEntries()[0]!;
    const blob = JSON.stringify(entry);
    expect(blob).not.toContain(SECRET_PROMPT);
    expect(blob).not.toContain('helpful assistant');
    // sanity: the hash IS recorded.
    expect(entry.promptHash).toBeTruthy();
    // full sha256 is 64 hex chars.
    expect(entry.promptHash).toHaveLength(64);
  });

  it('AuditSink interface works with a custom non-data-layer implementation', async () => {
    const captured: AuditEntry[] = [];
    const customSink: AuditSink = {
      record: async (e) => {
        captured.push(e);
      },
    };
    const primary = new MockProvider();
    const gateway = new LLMGateway({ primary, auditSink: customSink });

    await gateway.complete([{ role: 'user', content: 'hi' }], { model: 'test' });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.success).toBe(true);
  });

  it('sink failures do not break the LLM call', async () => {
    const primary = new MockProvider();
    const brokenSink: AuditSink = {
      record: async () => {
        throw new Error('database is on fire');
      },
    };
    const gateway = new LLMGateway({ primary, auditSink: brokenSink });

    const result = await gateway.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'test' },
    );
    expect(result.content).toBeTruthy();
  });
});
