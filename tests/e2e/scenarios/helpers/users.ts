/**
 * User + token creation helpers for RBAC scenarios.
 *
 * The default e2e SA is Admin. Tests that need a Viewer/Editor identity
 * mint a fresh local user via /api/admin/users and a personal access
 * token (or a session) for them, then run requests with that token.
 *
 * Returning a Bearer token (not a session cookie) keeps these helpers
 * compatible with the api-client.ts shape — but since api-client caches
 * the SA token at module load, callers do their own raw fetch with the
 * returned token (see `apiAs`).
 */
import { apiPost, BASE_URL, apiDelete } from './api-client.js';

export type Role = 'Viewer' | 'Editor' | 'Admin';

export interface TestUser {
  id: string;
  email: string;
  login: string;
  password: string;
}

interface CreateUserResp {
  id: string;
  email: string;
  login: string;
}

let counter = 0;

/** Create a local user with a generated email/password. */
export async function createUser(role: Role): Promise<TestUser> {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const email = `e2e-${role.toLowerCase()}-${stamp}@example.com`;
  const login = `e2e-${role.toLowerCase()}-${stamp}`;
  const password = `e2e-pw-${stamp}-strongenough`;
  const user = await apiPost<CreateUserResp>('/api/admin/users', {
    email,
    login,
    name: login,
    password,
    orgRole: role,
  });
  return { id: user.id, email, login, password };
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await apiDelete(`/api/admin/users/${id}`);
  } catch {
    /* best effort */
  }
}

/**
 * Login a local user (cookie session). Returns a `Cookie` header value
 * that can be used by `apiAs`.
 */
export async function loginAs(user: TestUser): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: user.login, password: user.password }),
  });
  if (!res.ok) {
    throw new Error(`login as ${user.login} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  // Take only the first cookie pair from each Set-Cookie entry.
  const pairs = setCookie
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter(Boolean);
  return pairs.join('; ');
}

export interface ApiAsResult {
  status: number;
  body: unknown;
}

/** Make a request as the given session cookie; never throws on non-2xx. */
export async function apiAs(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiAsResult> {
  const init: RequestInit = {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}
