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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_URL } from './api-client.js';

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

/**
 * Read the admin's session cookie (set by seed.sh) and pair it with a
 * freshly-minted CSRF token. /api/admin/* requires server-admin which
 * the seeded admin has but the e2e SA does not.
 */
async function adminCookieHeader(): Promise<string> {
  const cookieJarPath = join(process.cwd(), 'tests/e2e/.state/admin-cookie');
  const jar = readFileSync(cookieJarPath, 'utf8');
  // Lines starting with `#HttpOnly_` are still data — that prefix is the
  // Netscape jar's way of marking the HttpOnly flag for that line. Skip
  // only true comments (#  followed by space, or the file headers).
  const sessionLine = jar
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && l.includes('openobs_session') && !/^#\s/.test(l));
  if (!sessionLine) {
    throw new Error(
      `tests/e2e/.state/admin-cookie missing openobs_session — did seed.sh run?`,
    );
  }
  const sessionVal = sessionLine.split(/\t+/)[6] ?? '';
  // Hit a safe endpoint first so the response sets openobs_csrf.
  const probe = await fetch(`${BASE_URL}/api/whoami`, {
    headers: { cookie: `openobs_session=${sessionVal}` },
  });
  const setCookie = probe.headers.get('set-cookie') ?? '';
  const csrfMatch = setCookie.match(/openobs_csrf=([^;,\s]+)/);
  const csrf = csrfMatch?.[1] ?? '';
  return `openobs_session=${sessionVal}${csrf ? `; openobs_csrf=${csrf}` : ''}`;
}

async function adminCsrfToken(cookieHeader: string): Promise<string> {
  const m = cookieHeader.match(/openobs_csrf=([^;]+)/);
  return m?.[1] ?? '';
}

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const cookieHeader = await adminCookieHeader();
  const csrf = await adminCsrfToken(cookieHeader);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: cookieHeader,
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `admin ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return text.length > 0 ? JSON.parse(text) : undefined;
}

/** Create a local user with a generated email/password. */
export async function createUser(role: Role): Promise<TestUser> {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const email = `e2e-${role.toLowerCase()}-${stamp}@example.com`;
  const login = `e2e-${role.toLowerCase()}-${stamp}`;
  const password = `e2e-pw-${stamp}-strongenough`;
  const user = (await adminFetch('POST', '/api/admin/users', {
    email,
    login,
    name: login,
    password,
    orgRole: role,
  })) as CreateUserResp;
  return { id: user.id, email, login, password };
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await adminFetch('DELETE', `/api/admin/users/${id}`);
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
  // Cookie-auth mutating verbs need x-csrf-token mirroring openobs_csrf.
  // Mint a fresh CSRF cookie via a safe-method probe; the response
  // Set-Cookie carries it. Append to the cookie string before the real
  // request.
  let cookieWithCsrf = cookie;
  let csrfToken = '';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !/openobs_csrf=/.test(cookie)) {
    const probe = await fetch(`${BASE_URL}/api/whoami`, {
      method: 'GET',
      headers: { cookie },
    });
    const setCookie = probe.headers.get('set-cookie') ?? '';
    const m = setCookie.match(/openobs_csrf=([^;,\s]+)/);
    if (m?.[1]) {
      csrfToken = m[1];
      cookieWithCsrf = `${cookie}; openobs_csrf=${csrfToken}`;
    }
  } else if (/openobs_csrf=([^;]+)/.test(cookie)) {
    csrfToken = (cookie.match(/openobs_csrf=([^;]+)/) || [])[1] ?? '';
  }
  const init: RequestInit = {
    method,
    headers: {
      cookie: cookieWithCsrf,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
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
