/// <reference types="vite/client" />
import type {
  ResourceKind,
  ResourcePermissionEntry,
  ResourcePermissionSetItem,
} from '@agentic-obs/common';
import type { ApiResponse, SSEMessage } from './types.js';

/**
 * Build the REST path for a resource's permissions endpoint. Mirrors
 * docs/auth-perm-design/08-api-surface.md §permissions. Exported for tests.
 */
export function resourcePermissionsPath(resource: ResourceKind, uid: string): string {
  switch (resource) {
    case 'folders':
      return `/folders/${encodeURIComponent(uid)}/permissions`;
    case 'dashboards':
      return `/dashboards/uid/${encodeURIComponent(uid)}/permissions`;
    case 'datasources':
      return `/datasources/${encodeURIComponent(uid)}/permissions`;
    case 'alert.rules':
      return `/access-control/alert.rules/${encodeURIComponent(uid)}/permissions`;
  }
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Build auth headers from localStorage JWT or API key (legacy paths). */
  private authHeaders(): Record<string, string> {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('agentic_obs_auth');
    } catch (err) {
      // localStorage can throw in privacy-mode iframes / disabled storage.
      // Fall through to the api_key lookup below.
      console.warn('[api] localStorage.getItem(agentic_obs_auth) threw:', err);
    }
    if (raw) {
      try {
        const tokens = JSON.parse(raw) as { tokens?: { accessToken?: string } };
        if (tokens?.tokens?.accessToken) return { Authorization: `Bearer ${tokens.tokens.accessToken}` };
      } catch (err) {
        // A malformed token blob means this session is wedged — the user will
        // get 401s on every request with no way to recover short of clearing
        // storage manually. Surface it, clear the bad blob, and redirect to
        // login so the next load starts fresh.
        console.warn('[api] auth token blob in localStorage is malformed; clearing and redirecting to /login', err);
        try {
          localStorage.removeItem('agentic_obs_auth');
          localStorage.removeItem('api_key');
        } catch {
          // Can't clear — nothing more we can do. The redirect still helps.
        }
        if (typeof window !== 'undefined') window.location.href = '/login';
        return {};
      }
    }
    // Fall back to API key from localStorage (set during setup or login)
    try {
      const apiKey = localStorage.getItem('api_key');
      if (apiKey) return { 'x-api-key': apiKey };
    } catch (err) {
      console.warn('[api] localStorage.getItem(api_key) threw:', err);
    }
    return {};
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      // credentials: 'include' so the session cookie rides along on every request.
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
        ...options.headers,
      },
      ...options,
    });

    if (!res.ok) {
      if (res.status === 401 && !import.meta.env.DEV) {
        window.location.href = '/login';
        return { data: null as T, error: { code: 'UNAUTHORIZED', message: 'Redirecting to login...' } };
      }
      // Canonical error envelope is `{ error: { code, message, details? } }`
      // (see `middleware/error-handler.ts`). Fall back to the unwrapped shape
      // so this client works while routes are being migrated, and to
      // `res.statusText` when the body isn't JSON at all.
      const raw = await res.json().catch(() => null) as
        | { error?: { code?: string; message?: string; details?: unknown } | null; code?: string; message?: string }
        | null;
      const inner = raw?.error ?? raw;
      const error = {
        code: inner?.code ?? 'UNKNOWN',
        message: inner?.message ?? res.statusText,
        ...(inner && 'details' in inner && inner.details !== undefined
          ? { details: inner.details }
          : {}),
      };
      return { data: null as T, error };
    }

    if (res.status === 204) {
      return { data: null as T };
    }

    const data = await res.json() as T;
    return { data };
  }

  get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  put<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  patch<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * POST a request and consume the response as a Server-Sent Events stream.
   * Calls onEvent for each SSE event frame received.
   * Pass an AbortSignal to cancel mid-stream.
   */
  async postStream(
    path: string,
    body: unknown,
    onEvent: (eventType: string, rawData: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      if (res.status === 401) {
        // In dev mode the frontend skips login, but the backend still needs
        // DEV_AUTH_BYPASS=true in .env.  Surface a clear message instead of
        // a cryptic "Network error".
        throw new Error('Authentication required — add DEV_AUTH_BYPASS=true to .env and restart the server, or log in first.');
      }
      if (res.status === 403) {
        // Permission gate (HTTP layer or agent Layer 3 RBAC). Try to read
        // the canonical `{ error: { message } }` envelope and surface the
        // specific action the caller was denied; fall back to a generic
        // explanation when the body isn't structured.
        let detail = '';
        try {
          const body = await res.json() as { error?: { message?: string } };
          if (body?.error?.message) detail = `: ${body.error.message}`;
        } catch { /* non-JSON body */ }
        throw new Error(
          `Your role doesn't permit this action${detail}. Ask an administrator, or try a read-only question.`,
        );
      }
      throw new Error(`Stream request failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          onEvent(currentEvent, data);
          currentEvent = 'message';
        } else if (line.trim() === '') {
          currentEvent = 'message';
        }
      }
    }
  }

  /**
   * Subscribe to a Server-Sent Events stream.
   * Returns a cleanup function to close the connection.
   */
  sse<T = unknown>(
    path: string,
    onMessage: (msg: SSEMessage<T>) => void,
    onError?: (err: Event) => void,
  ): () => void {
    const source = new EventSource(`${this.baseUrl}${path}`);

    source.onmessage = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as T;
        onMessage({ event: 'message', data });
      } catch {
        // ignore malformed frames
      }
    };

    source.addEventListener('error', (e) => {
      onError?.(e);
    });

    return () => source.close();
  }
}

export const apiClient = new ApiClient(BASE_URL);

/**
 * Throwing convenience wrapper around apiClient.
 *
 * apiClient methods return `{ data, error }`. For code paths that prefer to
 * bubble failures via thrown errors (try/catch) rather than early-return, use
 * these helpers — they throw an Error with the server message if the request
 * fails, otherwise return the data directly.
 */
export const api = {
  /** Base path relative to `/api` (no leading slash required in baseUrl). */
  baseUrl: BASE_URL,

  async get<T>(path: string): Promise<T> {
    const { data, error } = await apiClient.get<T>(path);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async post<T>(path: string, body: unknown): Promise<T> {
    const { data, error } = await apiClient.post<T>(path, body);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async put<T>(path: string, body: unknown): Promise<T> {
    const { data, error } = await apiClient.put<T>(path, body);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async patch<T>(path: string, body: unknown): Promise<T> {
    const { data, error } = await apiClient.patch<T>(path, body);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async delete<T>(path: string): Promise<T> {
    const { data, error } = await apiClient.delete<T>(path);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },

  /**
   * List a resource's permissions. Returns the denormalized entry array used
   * by <PermissionsDialog>. See 08-api-surface.md §permissions.
   */
  async getResourcePermissions(
    resource: ResourceKind,
    uid: string,
  ): Promise<ResourcePermissionEntry[]> {
    const path = resourcePermissionsPath(resource, uid);
    const { data, error } = await apiClient.get<
      ResourcePermissionEntry[] | { items?: ResourcePermissionEntry[] }
    >(path);
    if (error) throw new Error(error.message ?? 'Request failed');
    // Grafana-parity sometimes wraps the list in `{ items }`; accept both.
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  },

  /**
   * Bulk-replace a resource's direct permissions. Body is the full desired
   * state, not a diff — matches Grafana's permission PUT semantics.
   */
  async setResourcePermissions(
    resource: ResourceKind,
    uid: string,
    items: ResourcePermissionSetItem[],
  ): Promise<void> {
    const path = resourcePermissionsPath(resource, uid);
    const { error } = await apiClient.post<unknown>(path, { items });
    if (error) throw new Error(error.message ?? 'Request failed');
  },
};

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
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
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

/**
 * Typed admin-surface endpoints consumed by the tabs in `pages/admin/`.
 * Each call is a thin wrapper around `api.*` so the admin UI can reference
 * a single catalog of endpoint paths. Paths match 08-api-surface.md.
 *
 * Response types intentionally live here as `unknown`: the admin tabs parse
 * the DTOs themselves (see `pages/admin/_shared.ts`) to tolerate minor
 * backend DTO drift without requiring a coordinated deploy.
 */
export const adminApi = {
  users: {
    listOrg: (qs: string): Promise<unknown> => api.get(`/org/users${qs}`),
    listAdmin: (qs: string): Promise<unknown> => api.get(`/admin/users${qs}`),
    create: (body: { name: string; login: string; email: string; password: string }): Promise<unknown> =>
      api.post('/admin/users', body),
    update: (id: string, body: Record<string, unknown>): Promise<unknown> =>
      api.put(`/admin/users/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/admin/users/${id}`),
    disable: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/disable`, {}),
    enable: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/enable`, {}),
    resetPassword: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/password`, {}),
    logoutAllSessions: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/logout`, {}),
    authTokens: (id: string): Promise<unknown> => api.get(`/admin/users/${id}/auth-tokens`),
  },
  teams: {
    search: (qs: string): Promise<unknown> => api.get(`/teams/search${qs}`),
    get: (id: string): Promise<unknown> => api.get(`/teams/${id}`),
    create: (body: { name: string; email?: string }): Promise<unknown> => api.post('/teams', body),
    update: (id: string, body: { name?: string; email?: string }): Promise<unknown> =>
      api.put(`/teams/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/teams/${id}`),
    members: (id: string): Promise<unknown> => api.get(`/teams/${id}/members`),
    addMember: (id: string, userId: string): Promise<unknown> =>
      api.post(`/teams/${id}/members`, { userId }),
    setMemberPermission: (id: string, userId: string, permission: number): Promise<unknown> =>
      api.put(`/teams/${id}/members/${userId}`, { permission }),
    removeMember: (id: string, userId: string): Promise<unknown> =>
      api.delete(`/teams/${id}/members/${userId}`),
    preferences: (id: string): Promise<unknown> => api.get(`/teams/${id}/preferences`),
    setPreferences: (id: string, body: Record<string, unknown>): Promise<unknown> =>
      api.put(`/teams/${id}/preferences`, body),
  },
  serviceAccounts: {
    search: (qs: string): Promise<unknown> => api.get(`/serviceaccounts/search${qs}`),
    create: (body: { name: string; role: string; isDisabled?: boolean }): Promise<unknown> =>
      api.post('/serviceaccounts', body),
    update: (id: string, body: Record<string, unknown>): Promise<unknown> =>
      api.patch(`/serviceaccounts/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/serviceaccounts/${id}`),
    tokens: (id: string): Promise<unknown> => api.get(`/serviceaccounts/${id}/tokens`),
    createToken: (
      id: string,
      body: { name: string; secondsToLive?: number },
    ): Promise<{ id: string; name: string; key: string }> =>
      api.post(`/serviceaccounts/${id}/tokens`, body),
    deleteToken: (id: string, tokenId: string): Promise<unknown> =>
      api.delete(`/serviceaccounts/${id}/tokens/${tokenId}`),
  },
  roles: {
    list: (qs: string): Promise<unknown> => api.get(`/access-control/roles${qs}`),
    get: (uid: string): Promise<unknown> => api.get(`/access-control/roles/${uid}`),
    create: (body: Record<string, unknown>): Promise<unknown> =>
      api.post('/access-control/roles', body),
    update: (uid: string, body: Record<string, unknown>): Promise<unknown> =>
      api.put(`/access-control/roles/${uid}`, body),
    delete: (uid: string): Promise<unknown> => api.delete(`/access-control/roles/${uid}`),
    assignToUser: (
      userId: string,
      body: { roleUid: string; global?: boolean },
    ): Promise<unknown> => api.post(`/access-control/users/${userId}/roles`, body),
    unassignFromUser: (userId: string, roleUid: string): Promise<unknown> =>
      api.delete(`/access-control/users/${userId}/roles/${roleUid}`),
    teamRoles: (teamId: string): Promise<unknown> =>
      api.get(`/access-control/teams/${teamId}/roles`),
    assignToTeam: (teamId: string, roleUid: string): Promise<unknown> =>
      api.post(`/access-control/teams/${teamId}/roles`, { roleUid }),
    unassignFromTeam: (teamId: string, roleUid: string): Promise<unknown> =>
      api.delete(`/access-control/teams/${teamId}/roles/${roleUid}`),
  },
  orgs: {
    list: (qs: string): Promise<unknown> => api.get(`/orgs${qs}`),
    create: (body: { name: string }): Promise<unknown> => api.post('/orgs', body),
    rename: (id: string, body: { name: string }): Promise<unknown> => api.put(`/orgs/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/orgs/${id}`),
  },
  auditLog: {
    list: (qs: string): Promise<unknown> => api.get(`/admin/audit-log${qs}`),
  },
};
