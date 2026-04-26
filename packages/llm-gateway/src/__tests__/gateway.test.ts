import { describe, it, expect } from 'vitest';
import { LLMGateway } from '../gateway.js';
import { MockProvider } from '../providers/mock.js';

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
      failKind: 'network',
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
      failKind: 'auth',
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
      failKind: 'unsupported',
      failMessage: 'feature not supported',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('feature not supported');

    expect(primary.callCount).toBe(1);
  });

  it('retries on raw 5xx-shaped Error from provider', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failMessage: 'OpenAI API error 503: upstream',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('503');

    // 5xx → retried.
    expect(primary.callCount).toBe(3);
  });

  it('does NOT retry raw 4xx-shaped Error from provider', async () => {
    const primary = new MockProvider({
      name: 'primary',
      shouldFail: true,
      failMessage: 'OpenAI API error 400: bad request',
    });
    const gateway = new LLMGateway({ primary, maxRetries: 3, retryDelayMs: 1 });

    await expect(
      gateway.complete([{ role: 'user', content: 'Hello' }], { model: 'test' }),
    ).rejects.toThrow('400');

    expect(primary.callCount).toBe(1);
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
});
