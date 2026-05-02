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
 *
 * /api/admin/users is server-admin-gated. We always mint users with the
 * cached SA Bearer token (which is the seeded server-admin SA), never
 * via a cookie session — Bearer auth bypasses CSRF, and the SA is the
 * one identity guaranteed to satisfy the server-admin gate.
 *
 * Cookie-auth state-changing requests need an X-CSRF-Token header that
 * matches the openobs_csrf cookie. /api/login only sets the session
 * cookie; the CSRF cookie is minted on the first authenticated GET. So
 * loginAs does the login + a primer GET, and apiAs auto-attaches the
 * CSRF header on non-safe methods.
 */
import { apiPost, apiDelete, BASE_URL, getSaToken } from './api-client.js';

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

/**
 * Create a server-admin user (isAdmin=true). Cross-org/server-admin-only
 * scenarios use this to verify the admin/server-admin boundary without
 * relying on the seed identity.
 */
export async function createServerAdmin(): Promise<TestUser> {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const email = `e2e-srvadmin-${stamp}@example.com`;
  const login = `e2e-srvadmin-${stamp}`;
  const password = `e2e-pw-${stamp}-strongenough`;
  const user = await apiPost<CreateUserResp>('/api/admin/users', {
    email,
    login,
    name: login,
    password,
    orgRole: 'Admin',
    isAdmin: true,
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

const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'openobs_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseSetCookie(setCookieHeader: string): string[] {
  // Take only the first cookie pair from each Set-Cookie entry.
  return setCookieHeader
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter(Boolean);
}

function readCookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return undefined;
}

function mergeCookies(existing: string, addition: string[]): string {
  if (addition.length === 0) return existing;
  const map = new Map<string, string>();
  for (const part of existing.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq > 0) map.set(t.slice(0, eq), t.slice(eq + 1));
  }
  for (const a of addition) {
    const eq = a.indexOf('=');
    if (eq > 0) map.set(a.slice(0, eq), a.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Login a local user (cookie session). Returns a `Cookie` header value
 * that can be used by `apiAs`. The returned cookie contains both the
 * session cookie and a freshly-issued CSRF cookie (primed via a GET to
 * /api/user) so subsequent state-changing requests can echo it.
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
  let cookie = parseSetCookie(setCookie).join('; ');

  // Prime CSRF cookie. The csrf middleware mints openobs_csrf on the first
  // safe-method request that has a session cookie but no CSRF cookie.
  const primer = await fetch(`${BASE_URL}/api/user`, {
    method: 'GET',
    headers: { cookie },
  });
  const primerSetCookie = primer.headers.get('set-cookie') ?? '';
  cookie = mergeCookies(cookie, parseSetCookie(primerSetCookie));
  return cookie;
}

export interface ApiAsResult {
  status: number;
  body: unknown;
}

/**
 * Make a request as the given session cookie; never throws on non-2xx.
 *
 * For non-safe methods, automatically adds X-CSRF-Token derived from the
 * cookie's openobs_csrf value. Bearer auth (cookie === '__bearer:<tok>')
 * is also supported for tests that want to skip session login entirely.
 */
export async function apiAs(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiAsResult> {
  const headers: Record<string, string> = {};
  if (cookie.startsWith('__bearer:')) {
    headers['authorization'] = `Bearer ${cookie.slice('__bearer:'.length)}`;
  } else {
    headers['cookie'] = cookie;
    if (!SAFE_METHODS.has(method.toUpperCase())) {
      const csrf = readCookieValue(cookie, CSRF_COOKIE);
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = {
    method,
    headers,
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

/** Wrap a Bearer token as a "cookie" so apiAs can use it uniformly. */
export function bearerAs(token: string): string {
  return `__bearer:${token}`;
}

/** The cached server-admin SA token (read by api-client at module load). */
export function adminBearer(): string {
  return bearerAs(getSaToken());
}
