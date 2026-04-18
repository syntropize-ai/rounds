/**
 * Verifies that `api.getResourcePermissions` / `api.setResourcePermissions`
 * hit the right URL + body per resource kind. Uses a `fetch` mock so we do
 * not need a real DOM or network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResourceKind } from '@agentic-obs/common';

// The apiClient reads localStorage at request time. Node has no DOM, so
// shim it before importing the client module. Shim must live before the
// first call, not necessarily before the import (the client only touches
// localStorage inside its request path).
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

import { api, resourcePermissionsPath } from '../../api/client.js';

type FetchMock = ReturnType<typeof vi.fn>;

function mockOk(body: unknown): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function mockError(status: number, body: { message: string }): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Bad',
    json: () => Promise.resolve(body),
  });
}

describe('api.getResourcePermissions / setResourcePermissions', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Ensure the client's auth header branch doesn't explode — no window.
    // (localStorage is undefined in node; the try/catch in authHeaders swallows.)
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const cases: Array<{ resource: ResourceKind; uid: string; expected: string }> = [
    { resource: 'folders', uid: 'f1', expected: '/api/folders/f1/permissions' },
    { resource: 'dashboards', uid: 'd1', expected: '/api/dashboards/uid/d1/permissions' },
    { resource: 'datasources', uid: 'ds1', expected: '/api/datasources/ds1/permissions' },
    {
      resource: 'alert.rules',
      uid: 'fa1',
      expected: '/api/access-control/alert.rules/fa1/permissions',
    },
  ];

  for (const c of cases) {
    it(`GET ${c.resource} hits ${c.expected}`, async () => {
      const mock = mockOk([]);
      globalThis.fetch = mock as unknown as typeof fetch;
      await api.getResourcePermissions(c.resource, c.uid);
      expect(mock).toHaveBeenCalledTimes(1);
      const url = (mock.mock.calls[0]?.[0] as string) ?? '';
      expect(url).toBe(c.expected);
    });

    it(`POST ${c.resource} hits ${c.expected} with items body`, async () => {
      const mock = mockOk({ message: 'ok' });
      globalThis.fetch = mock as unknown as typeof fetch;
      await api.setResourcePermissions(c.resource, c.uid, [
        { userId: 'u1', permission: 2 },
        { role: 'Viewer', permission: 1 },
      ]);
      expect(mock).toHaveBeenCalledTimes(1);
      const [url, init] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(c.expected);
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string) as { items: unknown[] };
      expect(body).toEqual({
        items: [
          { userId: 'u1', permission: 2 },
          { role: 'Viewer', permission: 1 },
        ],
      });
    });
  }

  it('getResourcePermissions accepts both array and {items} response shapes', async () => {
    globalThis.fetch = mockOk({ items: [{ id: 'x', roleName: 'r', isManaged: true, isInherited: false, permission: 1, actions: [] }] }) as unknown as typeof fetch;
    const out = await api.getResourcePermissions('folders', 'f1');
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('x');
  });

  it('setResourcePermissions surfaces server error messages', async () => {
    globalThis.fetch = mockError(500, { message: 'boom' }) as unknown as typeof fetch;
    await expect(
      api.setResourcePermissions('folders', 'f1', []),
    ).rejects.toThrow(/boom/);
  });

  it('resourcePermissionsPath is consistent with the endpoints used', () => {
    for (const c of cases) {
      // resourcePermissionsPath omits the /api prefix (the ApiClient adds it).
      const expectedWithoutApi = c.expected.replace(/^\/api/, '');
      expect(resourcePermissionsPath(c.resource, c.uid)).toBe(expectedWithoutApi);
    }
  });
});
