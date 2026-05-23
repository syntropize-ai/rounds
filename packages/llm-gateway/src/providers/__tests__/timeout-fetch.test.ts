/**
 * Tests for the per-request timeout wrapper around provider HTTP calls.
 * The wire-up exists so a stalled provider can't hang the react-loop
 * forever — a missing timeout used to manifest as "investigation sat on
 * step N for minutes with no error in the log".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timedFetch, makeTimedSignal, DEFAULT_PROVIDER_TIMEOUT_MS } from '../timeout-fetch.js';
import { ProviderError } from '../../types.js';

const originalFetch = global.fetch;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
});

describe('makeTimedSignal', () => {
  it('aborts after timeoutMs and reports isTimedOut=true', () => {
    const { signal, cleanup, isTimedOut } = makeTimedSignal({ timeoutMs: 1000 });
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(signal.aborted).toBe(true);
    expect(isTimedOut()).toBe(true);
    cleanup();
  });

  it('aborts when the caller signal aborts (not a timeout)', () => {
    const caller = new AbortController();
    const { signal, cleanup, isTimedOut } = makeTimedSignal({
      signal: caller.signal,
      timeoutMs: 60_000,
    });
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
    expect(isTimedOut()).toBe(false);
    cleanup();
  });

  it('aborts immediately when caller signal was already aborted', () => {
    const caller = new AbortController();
    caller.abort();
    const { signal, cleanup, isTimedOut } = makeTimedSignal({ signal: caller.signal });
    expect(signal.aborted).toBe(true);
    expect(isTimedOut()).toBe(false);
    cleanup();
  });
});

describe('timedFetch', () => {
  it('returns the response when fetch resolves before the timeout', async () => {
    const ok = new Response('hi', { status: 200 });
    global.fetch = vi.fn().mockResolvedValue(ok);
    const promise = timedFetch('https://x.test/', { method: 'POST' }, {
      provider: 'openai', displayName: 'OpenAI',
    });
    const res = await promise;
    expect(res).toBe(ok);
  });

  it('throws ProviderError({kind: timeout}) when the provider stalls past the deadline', async () => {
    // Simulate a fetch that hangs until aborted. We resolve the rejection
    // only when the abort signal fires, mirroring how `fetch` actually
    // behaves on AbortController.abort().
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const promise = timedFetch('https://x.test/', { method: 'POST' }, {
      provider: 'openai',
      displayName: 'OpenAI',
      timeoutMs: 50,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50);
    const err = await promise;
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('timeout');
    expect((err as ProviderError).provider).toBe('openai');
    expect((err as Error).message).toContain('OpenAI');
    expect((err as Error).message).toContain('50ms');
  });

  it('rethrows non-timeout transport errors without wrapping (caller classifies)', async () => {
    const transportErr = Object.assign(new Error('connect ECONNREFUSED'), {
      cause: { code: 'ECONNREFUSED' },
    });
    global.fetch = vi.fn().mockRejectedValue(transportErr);
    const err = await timedFetch('https://x.test/', { method: 'POST' }, {
      provider: 'openai', displayName: 'OpenAI',
    }).catch((e) => e);
    expect(err).toBe(transportErr);  // unchanged
  });

  it('default timeout is 120s when not overridden', () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(120_000);
  });
});
