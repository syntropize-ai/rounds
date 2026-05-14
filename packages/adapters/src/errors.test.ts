// Canonical AdapterError taxonomy tests (R-6 / T2.4 Phase 1).
//
// Covers the 6 scenarios required by the design doc:
//   - HTTP 401 from Prometheus  → kind: 'auth_failure'
//   - HTTP 429 from any adapter → kind: 'rate_limit'
//   - Timeout (AbortError)      → kind: 'timeout'
//   - DNS failure (ENOTFOUND)   → kind: 'dns_failure'
//   - Malformed JSON response   → kind: 'malformed_response'
//   - toUserMessage()           → safe / non-technical, no leakage

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AdapterError, classifyHttpError, isAdapterError } from './errors.js';
import { PrometheusMetricsAdapter } from './prometheus/metrics-adapter.js';
import { LokiLogsAdapter } from './loki/logs-adapter.js';

function makeResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

describe('classifyHttpError', () => {
  it('maps HTTP 401 to auth_failure', () => {
    expect(classifyHttpError({ status: 401 })).toBe('auth_failure');
  });

  it('maps HTTP 403 to auth_failure', () => {
    expect(classifyHttpError({ status: 403 })).toBe('auth_failure');
  });

  it('maps HTTP 429 to rate_limit', () => {
    expect(classifyHttpError({ status: 429 })).toBe('rate_limit');
  });

  it('maps HTTP 404 to not_found', () => {
    expect(classifyHttpError({ status: 404 })).toBe('not_found');
  });

  it('maps HTTP 400 to bad_request', () => {
    expect(classifyHttpError({ status: 400 })).toBe('bad_request');
  });

  it('maps HTTP 5xx to server_error', () => {
    expect(classifyHttpError({ status: 500 })).toBe('server_error');
    expect(classifyHttpError({ status: 503 })).toBe('server_error');
  });

  it('maps AbortError to timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyHttpError({ cause: err })).toBe('timeout');
  });

  it('maps ENOTFOUND error code to dns_failure', () => {
    const err = Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
    expect(classifyHttpError({ cause: err })).toBe('dns_failure');
  });

  it('maps ECONNREFUSED to connection_refused', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(classifyHttpError({ cause: err })).toBe('connection_refused');
  });

  it('maps ETIMEDOUT to timeout', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(classifyHttpError({ cause: err })).toBe('timeout');
  });

  it('falls back to connection_refused for generic "fetch failed" (legacy retry parity)', () => {
    // Pre-migration, raw "fetch failed" was classified as `network` and retried.
    // We classify it as connection_refused so the gateway's retry path still fires.
    expect(classifyHttpError({ cause: new Error('fetch failed') })).toBe('connection_refused');
  });

  it('returns unknown for novel errors', () => {
    expect(classifyHttpError({ cause: new Error('what is this') })).toBe('unknown');
    expect(classifyHttpError({})).toBe('unknown');
  });
});

describe('AdapterError', () => {
  it('is an Error subclass and the type guard works', () => {
    const e = new AdapterError('timeout', 'x', { adapterId: 'a', operation: 'op' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AdapterError);
    expect(isAdapterError(e)).toBe(true);
    expect(isAdapterError(new Error('plain'))).toBe(false);
  });

  it('exposes structured cause', () => {
    const original = new Error('ENOTFOUND');
    const e = new AdapterError('dns_failure', 'boom', {
      adapterId: 'prometheus',
      operation: 'query',
      status: 0,
      originalError: original,
    });
    expect(e.kind).toBe('dns_failure');
    expect(e.cause.adapterId).toBe('prometheus');
    expect(e.cause.operation).toBe('query');
    expect(e.cause.originalError).toBe(original);
  });
});

describe('toUserMessage()', () => {
  it('returns safe, non-technical text per kind', () => {
    const cases: Array<[string, RegExp]> = [
      ['timeout', /too long/i],
      ['dns_failure', /could not be reached/i],
      ['connection_refused', /refused/i],
      ['auth_failure', /authentication/i],
      ['rate_limit', /rate-limit/i],
      ['not_found', /not found/i],
      ['bad_request', /rejected/i],
      ['server_error', /unavailable/i],
      ['malformed_response', /unexpected response/i],
      ['readonly', /read-only/i],
      ['unknown', /unexpected error/i],
    ];
    for (const [kind, pattern] of cases) {
      const e = new AdapterError(kind as never, 'internal — secret-id-1234', {
        adapterId: 'prometheus',
        operation: 'query',
        status: 500,
        upstreamBody: 'leaky body',
        originalError: new Error('stack-trace-here'),
      });
      const msg = e.toUserMessage();
      expect(msg).toMatch(pattern);
      // Must not leak internal detail
      expect(msg).not.toContain('prometheus');
      expect(msg).not.toContain('500');
      expect(msg).not.toContain('secret-id-1234');
      expect(msg).not.toContain('leaky body');
      expect(msg).not.toContain('stack-trace-here');
    }
  });
});

describe('PrometheusMetricsAdapter — error scenarios', () => {
  let originalFetch: typeof fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResolve(res: Response) {
    originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => res);
  }

  function mockFetchReject(err: unknown) {
    originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => {
      throw err;
    });
  }

  it('HTTP 401 → AdapterError with kind: auth_failure', async () => {
    mockFetchResolve(makeResponse('unauthorized', 401, 'text/plain'));
    const adapter = new PrometheusMetricsAdapter('http://prom:9090');
    try {
      await adapter.listLabels('up');
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).kind).toBe('auth_failure');
      expect((err as AdapterError).cause.adapterId).toBe('prometheus');
      expect((err as AdapterError).cause.status).toBe(401);
    }
  });

  it('HTTP 429 → AdapterError with kind: rate_limit', async () => {
    mockFetchResolve(makeResponse('too many', 429, 'text/plain'));
    const adapter = new PrometheusMetricsAdapter('http://prom:9090');
    try {
      await adapter.fetchMetadata();
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).kind).toBe('rate_limit');
    }
  });

  it('timeout (AbortError) → AdapterError with kind: timeout', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    mockFetchReject(abort);
    const adapter = new PrometheusMetricsAdapter('http://prom:9090', {}, 10);
    try {
      await adapter.listLabels('up');
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).kind).toBe('timeout');
    }
  });

  it('DNS failure (ENOTFOUND) → AdapterError with kind: dns_failure', async () => {
    mockFetchReject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const adapter = new PrometheusMetricsAdapter('http://nope.invalid');
    try {
      await adapter.listLabels('up');
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).kind).toBe('dns_failure');
    }
  });

  it('malformed JSON response → AdapterError with kind: malformed_response', async () => {
    mockFetchResolve(makeResponse('<html>not json</html>', 200, 'text/html'));
    const adapter = new PrometheusMetricsAdapter('http://prom:9090');
    try {
      await adapter.fetchMetadata();
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).kind).toBe('malformed_response');
    }
  });

  it('toUserMessage() never leaks adapter id, status, or stack', async () => {
    mockFetchResolve(makeResponse('boom-secret', 500, 'text/plain'));
    const adapter = new PrometheusMetricsAdapter('http://prom:9090');
    try {
      await adapter.listLabels('up');
      throw new Error('should have thrown');
    } catch (err) {
      const userMsg = (err as AdapterError).toUserMessage();
      expect(userMsg).not.toContain('prometheus');
      expect(userMsg).not.toContain('500');
      expect(userMsg).not.toContain('boom-secret');
      expect(userMsg).not.toContain('at ');
    }
  });
});

describe('LokiLogsAdapter — HTTP 429 emits rate_limit', () => {
  let originalFetch: typeof fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('classifies 429 as rate_limit', async () => {
    originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () =>
      makeResponse('rate-limited', 429, 'text/plain'),
    );
    const adapter = new LokiLogsAdapter('http://loki:3100');
    try {
      await adapter.listLabels();
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).kind).toBe('rate_limit');
      expect((err as AdapterError).cause.adapterId).toBe('loki');
    }
  });
});
