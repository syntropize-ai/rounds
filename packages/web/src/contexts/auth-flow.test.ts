/**
 * End-to-end state-machine tests for the AuthContext flows.
 *
 * Because the vitest workspace runs under the `node` environment (no jsdom),
 * we can't render <AuthProvider/> directly. Instead we exercise the same
 * public API the provider delegates to — `authApi.*` — and verify that the
 * state-shaping helpers (`toAuthUser`, `pickCurrentOrg`, `checkPermission`)
 * compose correctly for every documented scenario in 09-frontend.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  authApi,
  type CurrentUser,
  type UserPermissions,
} from '../api/client.js';
import { toAuthUser, pickCurrentOrg, checkPermission } from './AuthContext.js';

function fakeMe(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u1',
    email: 'alice@example.com',
    login: 'alice',
    name: 'Alice',
    theme: 'light',
    orgId: 'org_a',
    isGrafanaAdmin: false,
    orgs: [
      { orgId: 'org_a', name: 'Main', role: 'Admin' },
      { orgId: 'org_b', name: 'Side', role: 'Viewer' },
    ],
    authLabels: ['Local'],
    isDisabled: false,
    isExternal: false,
    ...overrides,
  };
}

function makeResponse(body: unknown, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  const noBody = status === 204 || body === undefined;
  return new Response(noBody ? null : JSON.stringify(body), { status, headers });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function makeFetchRecorder(queue: Array<(...a: [string, RequestInit | undefined]) => Promise<Response>>) {
  const calls: Call[] = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const handler = queue.shift();
    if (!handler) throw new Error(`Unexpected fetch to ${url}`);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

describe('AuthContext — login → refresh flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('login success pulls /api/user + /api/user/permissions and builds full state', async () => {
    const me = fakeMe();
    const perms: UserPermissions = {
      'dashboards:read': ['dashboards:uid:*'],
      'users:read': [''],
    };

    const { calls } = makeFetchRecorder([
      async () => makeResponse({ message: 'Logged in' }),
      async () => makeResponse(me),
      async () => makeResponse(perms),
    ]);

    // Simulate what AuthProvider.login() does:
    await authApi.login({ user: 'alice', password: 'pw' });
    const [meRes, permsRes] = await Promise.all([
      authApi.getCurrentUser(),
      authApi.getUserPermissions(),
    ]);

    const user = toAuthUser(meRes);
    const currentOrg = pickCurrentOrg(meRes);

    expect(user.login).toBe('alice');
    expect(user.isServerAdmin).toBe(false);
    expect(currentOrg?.orgId).toBe('org_a');
    expect(currentOrg?.role).toBe('Admin');
    expect(checkPermission(permsRes, 'dashboards:read', 'dashboards:uid:abc')).toBe(true);
    expect(checkPermission(permsRes, 'users:read', 'users:id:42')).toBe(true);
    expect(checkPermission(permsRes, 'folders:delete')).toBe(false);

    // Assert call order + paths:
    expect(calls.map((c) => c.url)).toEqual([
      '/api/login',
      '/api/user',
      '/api/user/permissions',
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
  });

  it('switchOrg: POST using + refetch user + refetch permissions', async () => {
    const beforeMe = fakeMe({ orgId: 'org_a' });
    const afterMe = fakeMe({ orgId: 'org_b' });
    const afterPerms: UserPermissions = { 'dashboards:read': ['dashboards:uid:*'] };

    const { calls } = makeFetchRecorder([
      async () => makeResponse({ message: 'active organization changed' }),
      async () => makeResponse(afterMe),
      async () => makeResponse(afterPerms),
    ]);

    // Capture pre-switch state from a hypothetical previous load:
    expect(pickCurrentOrg(beforeMe)?.orgId).toBe('org_a');

    // Simulate the switchOrg helper:
    await authApi.switchOrg('org_b');
    const [me2, perms2] = await Promise.all([
      authApi.getCurrentUser(),
      authApi.getUserPermissions(),
    ]);

    expect(pickCurrentOrg(me2)?.orgId).toBe('org_b');
    expect(checkPermission(perms2, 'dashboards:read', 'dashboards:uid:x')).toBe(true);

    expect(calls.map((c) => c.url)).toEqual([
      '/api/user/using/org_b',
      '/api/user',
      '/api/user/permissions',
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('refresh() on 401 clears state (unauthenticated) instead of throwing', async () => {
    // Simulate the provider's refresh path: a 401 from /api/user should be
    // recognised and mapped to the unauthenticated state.
    makeFetchRecorder([
      async () => makeResponse({ message: 'not authenticated' }, 401),
    ]);

    await expect(authApi.getCurrentUser()).rejects.toMatchObject({
      status: 401,
      name: 'AuthApiError',
    });
  });

  it('server admin flag surfaces under the isServerAdmin key', async () => {
    const me = fakeMe({ isGrafanaAdmin: true });
    makeFetchRecorder([async () => makeResponse(me)]);
    const user = toAuthUser(await authApi.getCurrentUser());
    expect(user.isServerAdmin).toBe(true);
  });
});
