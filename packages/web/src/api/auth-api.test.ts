/**
 * Unit tests for the typed auth endpoints in api/client.ts.
 *
 * These stub the global `fetch` to verify that each endpoint uses the right
 * method, path, cookie semantics, and error mapping. No DOM required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authApi, AuthApiError } from './client.js';

type FetchArgs = [url: string, init?: RequestInit];

function makeResponse(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers({ 'content-type': init.contentType ?? 'application/json' });
  // Per the Fetch spec, 204/205/304 MUST have a null body. The `Response`
  // constructor enforces this — passing a non-null body throws.
  const noBodyStatuses = new Set([204, 205, 304]);
  const bodyInit =
    noBodyStatuses.has(status) || body === undefined
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

describe('authApi', () => {
  beforeEach(() => {
    // no-op; each test stubs fetch explicitly
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('login POSTs /api/login with credentials: include', async () => {
    const spy = mockFetch(async () =>
      makeResponse({ message: 'Logged in', redirectUrl: '/' }),
    );
    const res = await authApi.login({ user: 'alice', password: 'hunter2' });
    expect(res.message).toBe('Logged in');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/login');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.body).toBe(JSON.stringify({ user: 'alice', password: 'hunter2' }));
  });

  it('login 401 throws AuthApiError with status 401', async () => {
    mockFetch(async () =>
      makeResponse({ message: 'invalid username or password' }, { status: 401 }),
    );
    await expect(authApi.login({ user: 'x', password: 'y' })).rejects.toMatchObject({
      name: 'AuthApiError',
      status: 401,
      message: 'invalid username or password',
    });
  });

  it('login 429 preserves the server rate-limit message', async () => {
    mockFetch(async () =>
      makeResponse({ message: 'too many login attempts, retry in 2 minutes' }, { status: 429 }),
    );
    await expect(authApi.login({ user: 'x', password: 'y' })).rejects.toSatisfy((err) => {
      return (
        err instanceof AuthApiError &&
        err.status === 429 &&
        /minutes/.test(err.message)
      );
    });
  });

  it('logout POSTs /api/logout', async () => {
    const spy = mockFetch(async () => makeResponse(undefined, { status: 204 }));
    await authApi.logout();
    const [url, init] = spy.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/logout');
    expect(init?.method).toBe('POST');
  });

  it('logout swallows 204 empty body correctly', async () => {
    mockFetch(async () => makeResponse(undefined, { status: 204 }));
    await expect(authApi.logout()).resolves.toBeUndefined();
  });

  it('getCurrentUser GETs /api/user and returns JSON', async () => {
    const user = {
      id: 'u1',
      email: 'a@b.c',
      login: 'alice',
      name: 'Alice',
      theme: 'dark',
      orgId: 'org_a',
      isGrafanaAdmin: false,
      orgs: [{ orgId: 'org_a', name: 'A', role: 'Admin' }],
      authLabels: [],
      isDisabled: false,
      isExternal: false,
    };
    const spy = mockFetch(async () => makeResponse(user));
    const res = await authApi.getCurrentUser();
    expect(res).toEqual(user);
    const [url, init] = spy.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/user');
    // Default method for fetch is GET; init.method should be undefined
    expect(init?.method).toBeUndefined();
  });

  it('getUserPermissions returns the scope map', async () => {
    const perms = {
      'dashboards:read': ['dashboards:uid:*'],
      'folders:write': ['folders:uid:f1'],
    };
    mockFetch(async () => makeResponse(perms));
    const res = await authApi.getUserPermissions();
    expect(res).toEqual(perms);
  });

  it('getLoginProviders returns the provider list', async () => {
    const list = [
      { id: 'local', name: 'Username / password', enabled: true },
      { id: 'github', name: 'GitHub', enabled: true, url: '/api/login/github' },
    ];
    mockFetch(async () => makeResponse(list));
    const res = await authApi.getLoginProviders();
    expect(res).toEqual(list);
  });

  it('switchOrg URL-encodes the org id and POSTs', async () => {
    const spy = mockFetch(async () =>
      makeResponse({ message: 'active organization changed' }),
    );
    await authApi.switchOrg('org/with spaces');
    const [url, init] = spy.mock.calls[0] as FetchArgs;
    expect(url).toBe(`/api/user/using/${encodeURIComponent('org/with spaces')}`);
    expect(init?.method).toBe('POST');
  });

  it('maps 5xx responses with a non-JSON body to AuthApiError', async () => {
    mockFetch(async () =>
      makeResponse('internal error', { status: 502, contentType: 'text/plain' }),
    );
    await expect(authApi.getCurrentUser()).rejects.toMatchObject({
      name: 'AuthApiError',
      status: 502,
    });
  });
});
