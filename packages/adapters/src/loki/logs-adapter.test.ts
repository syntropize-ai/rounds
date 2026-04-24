/**
 * Unit tests for LokiLogsAdapter.
 *
 * We stub globalThis.fetch with a vi.fn so the adapter calls are exercised
 * without a live Loki. Each test inspects the URL/headers the adapter sent
 * and returns a canned Response (or throws to simulate AbortSignal timeout).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LokiLogsAdapter } from './logs-adapter.js';

type FetchArgs = [url: string, init?: RequestInit];

function makeResponse(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers({
    'content-type': init.contentType ?? 'application/json',
  });
  const bodyInit =
    body === undefined
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  return new Response(bodyInit, { status, headers });
}

function mockFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('LokiLogsAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('query()', () => {
    it('parses streams, flattens entries, converts ns → ISO-8601', async () => {
      // 2024-01-01T00:00:00.000Z == 1704067200000ms == 1704067200000000000ns
      const ns1 = '1704067200000000000';
      const ns2 = '1704067260000000000'; // +60s
      const spy = mockFetch(async () =>
        makeResponse({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { app: 'api', level: 'info' },
                values: [
                  [ns1, 'hello'],
                  [ns2, 'world'],
                ],
              },
              {
                stream: { app: 'db' },
                values: [[ns1, 'db up']],
              },
            ],
          },
        }),
      );

      const adapter = new LokiLogsAdapter('http://loki:3100', {
        'X-Scope-OrgID': 'tenant-a',
      });
      const result = await adapter.query({
        query: '{app="api"}',
        start: new Date('2024-01-01T00:00:00Z'),
        end: new Date('2024-01-01T01:00:00Z'),
      });

      expect(result.entries).toHaveLength(3);
      // backward direction ⇒ newest first after sort
      expect(result.entries[0]).toEqual({
        timestamp: '2024-01-01T00:01:00.000Z',
        message: 'world',
        labels: { app: 'api', level: 'info' },
      });
      // Ties broken by insertion order is fine; both must have correct ISO
      const secondThird = [result.entries[1], result.entries[2]];
      expect(secondThird.every((e) => e.timestamp === '2024-01-01T00:00:00.000Z')).toBe(true);
      const msgs = secondThird.map((e) => e.message).sort();
      expect(msgs).toEqual(['db up', 'hello']);
      expect(result.partial).toBe(false);
      expect(result.warnings).toBeUndefined();

      // Verify URL parts
      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0] as FetchArgs;
      expect(url).toContain('http://loki:3100/loki/api/v1/query_range?');
      expect(url).toContain('query=%7Bapp%3D%22api%22%7D'); // {app="api"} encoded
      expect(url).toContain(`start=${ns1}`);
      expect(url).toContain('limit=100');
      expect(url).toContain('direction=backward');
      expect(init?.headers).toEqual({ 'X-Scope-OrgID': 'tenant-a' });
    });

    it('throws on non-2xx HTTP response with status + body preview', async () => {
      mockFetch(async () =>
        makeResponse('parse error: unexpected token', {
          status: 400,
          contentType: 'text/plain',
        }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      await expect(
        adapter.query({
          query: 'invalid-logql',
          start: new Date('2024-01-01T00:00:00Z'),
          end: new Date('2024-01-01T00:05:00Z'),
        }),
      ).rejects.toThrow(/HTTP 400.*parse error/);
    });

    it('forwards custom limit in the request', async () => {
      const spy = mockFetch(async () =>
        makeResponse({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      await adapter.query({
        query: '{app="api"}',
        start: new Date('2024-01-01T00:00:00Z'),
        end: new Date('2024-01-01T00:05:00Z'),
        limit: 500,
      });
      const [url] = spy.mock.calls[0] as FetchArgs;
      expect(url).toContain('limit=500');
    });

    it('marks partial=true when returned entry count reaches limit', async () => {
      const ns = '1704067200000000000';
      mockFetch(async () =>
        makeResponse({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { app: 'api' },
                values: [
                  [ns, 'a'],
                  [ns, 'b'],
                ],
              },
            ],
          },
        }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      const result = await adapter.query({
        query: '{app="api"}',
        start: new Date('2024-01-01T00:00:00Z'),
        end: new Date('2024-01-01T00:05:00Z'),
        limit: 2,
      });
      expect(result.entries).toHaveLength(2);
      expect(result.partial).toBe(true);
    });

    it('surfaces a warning when resultType is matrix (metric LogQL)', async () => {
      mockFetch(async () =>
        makeResponse({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [{ metric: { app: 'api' }, values: [[1704067200, '5']] }],
          },
        }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      const result = await adapter.query({
        query: 'rate({app="api"}[5m])',
        start: new Date('2024-01-01T00:00:00Z'),
        end: new Date('2024-01-01T00:05:00Z'),
      });
      expect(result.entries).toEqual([]);
      expect(result.partial).toBe(true);
      expect(result.warnings?.[0]).toMatch(/matrix/);
    });
  });

  describe('listLabels()', () => {
    it('returns the label list', async () => {
      const spy = mockFetch(async () =>
        makeResponse({ status: 'success', data: ['app', 'service', 'level'] }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      const labels = await adapter.listLabels();
      expect(labels).toEqual(['app', 'service', 'level']);
      const [url] = spy.mock.calls[0] as FetchArgs;
      expect(url).toBe('http://loki:3100/loki/api/v1/labels');
    });

    it('throws on HTTP error', async () => {
      mockFetch(async () => makeResponse('boom', { status: 500, contentType: 'text/plain' }));
      const adapter = new LokiLogsAdapter('http://loki:3100');
      await expect(adapter.listLabels()).rejects.toThrow(/HTTP 500.*boom/);
    });
  });

  describe('listLabelValues()', () => {
    it('URL-encodes the label name', async () => {
      const spy = mockFetch(async () =>
        makeResponse({ status: 'success', data: ['nginx', 'api'] }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      const values = await adapter.listLabelValues('app/name');
      expect(values).toEqual(['nginx', 'api']);
      const [url] = spy.mock.calls[0] as FetchArgs;
      expect(url).toBe(
        `http://loki:3100/loki/api/v1/label/${encodeURIComponent('app/name')}/values`,
      );
    });
  });

  describe('isHealthy()', () => {
    it('returns true when /ready is 200 and body contains "ready"', async () => {
      mockFetch(async () =>
        makeResponse('ready\n', { status: 200, contentType: 'text/plain' }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      await expect(adapter.isHealthy()).resolves.toBe(true);
    });

    it('returns false when /ready returns a non-200', async () => {
      mockFetch(async () =>
        makeResponse('starting', { status: 503, contentType: 'text/plain' }),
      );
      const adapter = new LokiLogsAdapter('http://loki:3100');
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    it('returns false when fetch throws (never throws itself)', async () => {
      mockFetch(async () => {
        throw new Error('ECONNREFUSED');
      });
      const adapter = new LokiLogsAdapter('http://loki:3100');
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });
  });

  describe('timeout behavior', () => {
    it('wraps AbortError from AbortSignal.timeout with a meaningful message', async () => {
      // Simulate what fetch() does when AbortSignal.timeout trips: it rejects with
      // a DOMException named "TimeoutError" (or AbortError depending on runtime).
      mockFetch(async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      });
      const adapter = new LokiLogsAdapter('http://loki:3100', {}, 10);
      await expect(
        adapter.query({
          query: '{app="api"}',
          start: new Date('2024-01-01T00:00:00Z'),
          end: new Date('2024-01-01T00:05:00Z'),
        }),
      ).rejects.toThrow(/query_range request failed.*timeout/);
    });
  });
});
