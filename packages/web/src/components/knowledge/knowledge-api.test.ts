/**
 * Wire-shape tests for the knowledge api wrapper:
 * - GET /kb/entries (+ source/limit query)
 * - GET /kb/entries/:id
 * - POST /kb/entries with skill-style body
 * - PUT /kb/entries/:id with patch body
 * - DELETE /kb/entries/:id
 *
 * Uses a fetch mock; matches the pattern in connectors/policies-api.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

import { defaultKnowledgeApi, buildListQuery } from './knowledge-api.js';

type FetchMock = ReturnType<typeof vi.fn>;

function mockOk(body: unknown): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe('buildListQuery', () => {
  it('returns empty string when no filter', () => {
    expect(buildListQuery()).toBe('');
    expect(buildListQuery({})).toBe('');
  });

  it('encodes source + limit', () => {
    expect(buildListQuery({ source: 'bundled', limit: 50 })).toBe(
      '?source=bundled&limit=50',
    );
  });

  it('omits undefined fields', () => {
    expect(buildListQuery({ source: 'saved' })).toBe('?source=saved');
  });
});

describe('defaultKnowledgeApi', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('list() hits /kb/entries with no filter', async () => {
    const mock = mockOk({ entries: [] });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultKnowledgeApi.list();
    expect(mock).toHaveBeenCalledTimes(1);
    const url = (mock.mock.calls[0]?.[0] as string) ?? '';
    expect(url).toBe('/api/kb/entries');
  });

  it('list() appends source query', async () => {
    const mock = mockOk({ entries: [] });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultKnowledgeApi.list({ source: 'saved' });
    const url = (mock.mock.calls[0]?.[0] as string) ?? '';
    expect(url).toBe('/api/kb/entries?source=saved');
  });

  it('get() hits /kb/entries/:id', async () => {
    const mock = mockOk({ entry: { id: 'e1' } });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultKnowledgeApi.get('e 1');
    const url = (mock.mock.calls[0]?.[0] as string) ?? '';
    expect(url).toBe('/api/kb/entries/e%201');
  });

  it('create() POSTs skill-style body verbatim', async () => {
    const mock = mockOk({ entry: { id: 'e1' } });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultKnowledgeApi.create({
      title: 'PostgreSQL slow queries',
      description: 'When investigating PostgreSQL slow queries...',
      body: '## Key metrics\n\n- pg_stat_statements',
      intentTags: ['oncall', 'db'],
      sourceRef: 'https://example.com',
    });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/kb/entries');
    expect(init.method).toBe('POST');
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({
      title: 'PostgreSQL slow queries',
      description: 'When investigating PostgreSQL slow queries...',
      body: '## Key metrics\n\n- pg_stat_statements',
      intentTags: ['oncall', 'db'],
      sourceRef: 'https://example.com',
    });
    expect(parsed).not.toHaveProperty('kind');
    expect(parsed).not.toHaveProperty('content');
  });

  it('update() PUTs to /kb/entries/:id with patch body', async () => {
    const mock = mockOk({ entry: { id: 'e1' } });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultKnowledgeApi.update('e1', { title: 'Renamed' });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/kb/entries/e1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Renamed' });
  });

  it('remove() DELETEs the row', async () => {
    const mock = mockOk({});
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultKnowledgeApi.remove('e1');
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/kb/entries/e1');
    expect(init.method).toBe('DELETE');
  });
});
