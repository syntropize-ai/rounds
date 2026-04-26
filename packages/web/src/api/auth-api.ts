import { csrfHeaders } from './headers.js';

/**
 * Typed auth endpoints — cookie-authenticated, matches 08-api-surface.md.
 *
 * These call the `/api/...` base directly (bypassing `baseUrl`) because
 * cookie auth is path-scoped and the error shape is `{ message, traceID }`
 * per the API contract, not the `{ data, error }` wrapper used elsewhere.
 */

export interface LoginProvider {
  id: string;
  name: string;
  enabled: boolean;
  url?: string;
}

export interface OrgMembership {
  orgId: string;
  name: string;
  role: import('@agentic-obs/common').OrgRole;
}

export interface CurrentUser {
  id: string;
  email: string;
  login: string;
  name: string;
  theme: string;
  orgId: string;
  isGrafanaAdmin: boolean;
  orgs: OrgMembership[];
  authLabels: string[];
  isDisabled: boolean;
  isExternal: boolean;
  avatarUrl?: string;
}

export type UserPermissions = Record<string, string[]>;

/**
 * HTTP error raised by the typed auth API calls. Callers inspect `status`
 * and `message` (matches backend `{ message }` shape).
 */
export class AuthApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
    this.body = body;
  }
}

async function authFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...csrfHeaders(method),
      ...(init.headers ?? {}),
    },
    ...init,
  });

  if (!res.ok) {
    let body: unknown;
    let message = res.statusText || `Request failed (${res.status})`;
    try {
      body = await res.json();
      // Canonical shape is `{ error: { code, message } }`; fall back to the
      // legacy `{ message }` shape until every auth route is migrated. 2xx
      // success messages (e.g. /api/login → { message: 'Logged in' }) don't
      // hit this branch.
      if (body && typeof body === 'object') {
        const nested = (body as { error?: { message?: unknown } }).error?.message;
        const flat = (body as { message?: unknown }).message;
        const m = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : undefined;
        if (m) message = m;
      }
    } catch {
      // non-JSON body; keep statusText
    }
    throw new AuthApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;
  // Some endpoints return only a message (e.g. /api/login, /api/user/using/:orgId).
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const authApi = {
  login(body: { user: string; password: string }): Promise<{ message: string; redirectUrl?: string }> {
    return authFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  logout(): Promise<void> {
    return authFetch<void>('/api/logout', { method: 'POST' });
  },
  getCurrentUser(): Promise<CurrentUser> {
    return authFetch<CurrentUser>('/api/user');
  },
  getUserPermissions(): Promise<UserPermissions> {
    return authFetch<UserPermissions>('/api/user/permissions');
  },
  getLoginProviders(): Promise<LoginProvider[]> {
    return authFetch<LoginProvider[]>('/api/login/providers');
  },
  switchOrg(orgId: string): Promise<{ message: string }> {
    return authFetch(`/api/user/using/${encodeURIComponent(orgId)}`, {
      method: 'POST',
    });
  },
};
