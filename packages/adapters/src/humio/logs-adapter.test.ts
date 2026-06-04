import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumioLogsAdapter, normalizeHumioBaseUrl } from './logs-adapter.js';

type FetchArgs = [url: string, init?: RequestInit];

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('HumioLogsAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a query job, polls it, and maps events to log entries', async () => {
    const spy = mockFetch(async (url, init) => {
      if (String(url).endsWith('/queryjobs') && init?.method === 'POST') {
        return makeResponse({ id: 'job-1' });
      }
      return makeResponse({
        done: true,
        events: [
          {
            '@timestamp': 1704067200000,
            '@rawstring': 'hello',
            service: 'api',
          },
        ],
      });
    });

    const adapter = new HumioLogsAdapter(
      'https://cloud.us.humio.com/api/v1',
      'prod',
      { Authorization: 'Bearer token' },
    );
    const result = await adapter.query({
      query: 'service=api',
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2024-01-01T01:00:00Z'),
      limit: 10,
    });

    expect(result.entries).toEqual([
      {
        timestamp: '2024-01-01T00:00:00.000Z',
        message: 'hello',
        labels: {
          '@timestamp': '1704067200000',
          service: 'api',
        },
      },
    ]);
    expect(result.partial).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = spy.mock.calls[0] as FetchArgs;
    expect(createUrl).toBe('https://cloud.us.humio.com/api/v1/repositories/prod/queryjobs');
    expect(createInit?.headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      queryString: 'service=api',
      isLive: false,
      noResultUntilDone: true,
    });
  });

  it('discovers field names via fieldset()', async () => {
    mockFetch(async (url, init) => {
      if (String(url).endsWith('/queryjobs') && init?.method === 'POST') {
        return makeResponse({ id: 'job-1' });
      }
      return makeResponse({
        done: true,
        events: [{ fields: '@host\nservice\n_count\n@timestamp' }],
      });
    });
    const adapter = new HumioLogsAdapter('https://humio.example', 'repo');
    await expect(adapter.listLabels()).resolves.toEqual(['@host', 'service']);
  });

  it('normalizes base URLs that already include /api/v1', () => {
    expect(normalizeHumioBaseUrl('https://humio.example/api/v1/')).toBe('https://humio.example');
    expect(normalizeHumioBaseUrl('https://humio.example')).toBe('https://humio.example');
  });
});
