/**
 * Verifies the wire shape of the connectors policies api wrapper:
 * - GET /connectors/:id/policies?subjectType=...&subjectId=...
 * - PUT /connectors/:id/policies with the upsert body
 * - DELETE /connectors/:id/policies/:subjectType/:subjectId/:capability
 *
 * Uses a fetch mock so the test stays in node with no DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { defaultPoliciesApi } from './policies-api.js';

type FetchMock = ReturnType<typeof vi.fn>;

function mockOk(body: unknown): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe('defaultPoliciesApi', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // no-op
  });

  it('list(org) hits /connectors/:id/policies?subjectType=org&subjectId=...', async () => {
    const mock = mockOk({ policies: [] });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultPoliciesApi.list('c1', 'org', 'org-42');
    expect(mock).toHaveBeenCalledTimes(1);
    const url = (mock.mock.calls[0]?.[0] as string) ?? '';
    expect(url).toBe('/api/connectors/c1/policies?subjectType=org&subjectId=org-42');
  });

  it('list(team) passes team subject', async () => {
    const mock = mockOk({ policies: [] });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultPoliciesApi.list('c1', 'team', 't-9');
    const url = (mock.mock.calls[0]?.[0] as string) ?? '';
    expect(url).toBe('/api/connectors/c1/policies?subjectType=team&subjectId=t-9');
  });

  it('upsert PUTs the body verbatim', async () => {
    const mock = mockOk({
      policy: {
        connectorId: 'c1',
        subjectType: 'org',
        subjectId: 'org-1',
        capability: 'metrics.query',
        scope: null,
        humanPolicy: 'allow',
      },
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultPoliciesApi.upsert('c1', {
      subjectType: 'org',
      subjectId: 'org-1',
      capability: 'metrics.query',
      humanPolicy: 'allow',
    });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/connectors/c1/policies');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      subjectType: 'org',
      subjectId: 'org-1',
      capability: 'metrics.query',
      humanPolicy: 'allow',
    });
  });

  it('remove DELETEs the team-level row', async () => {
    const mock = mockOk({});
    globalThis.fetch = mock as unknown as typeof fetch;
    await defaultPoliciesApi.remove('c1', 'team', 't-9', 'metrics.query');
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/connectors/c1/policies/team/t-9/metrics.query');
    expect(init.method).toBe('DELETE');
  });

  it('listTeams hits /teams/search?perpage=200', async () => {
    const mock = mockOk({ teams: [{ id: 't1', name: 'Platform' }] });
    globalThis.fetch = mock as unknown as typeof fetch;
    const out = await defaultPoliciesApi.listTeams();
    const url = (mock.mock.calls[0]?.[0] as string) ?? '';
    expect(url).toBe('/api/teams/search?perpage=200');
    expect(out).toEqual([{ id: 't1', name: 'Platform' }]);
  });
});
