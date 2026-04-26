/// <reference types="vite/client" />
import type { ApiResponse, SSEMessage } from './types.js';
import type { z } from 'zod';
import { parseOrThrow } from './schemas.js';
import { authHeaders, csrfHeaders } from './headers.js';
import { postStream as postSseStream, sse as subscribeSse } from './streaming.js';

const REQUEST_TIMEOUT_MS = 30_000;

function requestError(code: string, message: string): import('@agentic-obs/common').ApiError {
  return { code, message } as import('@agentic-obs/common').ApiError;
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    const method = options.method ?? 'GET';
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, REQUEST_TIMEOUT_MS);
    const upstreamSignal = options.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

    if (upstreamSignal?.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        // credentials: 'include' so the session cookie rides along on every request.
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
          ...csrfHeaders(method),
          ...options.headers,
        },
        signal: controller.signal,
      });
    } catch {
      const abortedByTimeout = controller.signal.aborted && !upstreamSignal?.aborted;
      const message = abortedByTimeout
        ? 'Request timed out. Check that the API server and upstream service are reachable.'
        : 'Cannot reach the OpenObs API. Check that the API server is running.';
      return {
        data: null as T,
        error: requestError(abortedByTimeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', message),
      };
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }

    if (!res.ok) {
      if (res.status === 401) {
        // Unify DEV and prod: both redirect to /login. Previously DEV silently
        // returned a fake `{ error: { code: 'UNKNOWN' } }` envelope, which let
        // pages render in a half-broken state. The DEV-only console.warn keeps
        // the local-dev signal that something needs attention (likely a
        // missing DEV_AUTH_BYPASS in the backend .env).
        if (import.meta.env.DEV) {
          console.warn('[api] 401 from', path, '— redirecting to /login (DEV: check DEV_AUTH_BYPASS)');
        }
        if (typeof window !== 'undefined') window.location.href = '/login';
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
      // Attach the HTTP status so callers can distinguish 404 vs 5xx without
      // inspecting `res` themselves; DashboardWorkspace and useChat both rely
      // on this. ApiError doesn't declare `status`, but we attach it as an
      // extra property — callers narrow it via `(res.error as { status }).status`.
      const error = {
        code: inner?.code ?? 'UNKNOWN',
        message: inner?.message ?? res.statusText,
        status: res.status,
        ...(inner && 'details' in inner && inner.details !== undefined
          ? { details: inner.details }
          : {}),
      } as import('@agentic-obs/common').ApiError;
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
   * Internal: post-process a successful response by validating its body
   * against `schema` before handing back to the caller. We deliberately keep
   * the generic `<T>` independent from the schema's inferred type — the
   * caller's local TS type is the contract; the schema is the runtime
   * shape-check at the integration boundary. On parse failure
   * `ApiResponseShapeError` propagates from `parseOrThrow`.
   */
  private validateResponse<T>(
    res: ApiResponse<unknown>,
    schema: z.ZodTypeAny,
    schemaName: string,
  ): ApiResponse<T> {
    if (res.error || res.data === null || res.data === undefined) {
      return res as ApiResponse<T>;
    }
    const parsed = parseOrThrow(schema, schemaName, res.data);
    return { data: parsed as T };
  }

  /**
   * GET + zod-validate the response data against `schema`. Used for the four
   * highest-value response shapes (Dashboard, PanelConfig, RangeResponse,
   * InstantResponse) — callers that don't pass a schema get the legacy
   * `as T` cast behavior.
   */
  async getValidated<T>(
    path: string,
    schema: z.ZodTypeAny,
    schemaName: string,
  ): Promise<ApiResponse<T>> {
    const res = await this.request<unknown>(path);
    return this.validateResponse<T>(res, schema, schemaName);
  }

  async postValidated<T>(
    path: string,
    body: unknown,
    schema: z.ZodTypeAny,
    schemaName: string,
  ): Promise<ApiResponse<T>> {
    const res = await this.request<unknown>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.validateResponse<T>(res, schema, schemaName);
  }

  async putValidated<T>(
    path: string,
    body: unknown,
    schema: z.ZodTypeAny,
    schemaName: string,
  ): Promise<ApiResponse<T>> {
    const res = await this.request<unknown>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return this.validateResponse<T>(res, schema, schemaName);
  }

  postStream(
    path: string,
    body: unknown,
    onEvent: (eventType: string, rawData: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return postSseStream(this.baseUrl, path, body, onEvent, signal);
  }

  sse<T = unknown>(
    path: string,
    onMessage: (msg: SSEMessage<T>) => void,
    onError?: (err: Event) => void,
  ): () => void {
    return subscribeSse(this.baseUrl, path, onMessage, onError);
  }
}
