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

/**
 * Thrown when transport detects an unauthenticated session — either from a
 * 401 response or from `authHeaders()` finding a malformed token blob. The
 * auth-boundary handler registered via `setUnauthorizedHandler` decides what
 * to do (clear local storage, redirect). Transport itself is kept free of
 * DOM and storage side effects so it remains testable in node.
 */
export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED';
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

let unauthorizedHandler: ((err: UnauthorizedError) => void) | null = null;

/**
 * Register a single handler invoked when transport detects an
 * unauthenticated state. Returns the previously-registered handler (or null)
 * so callers can chain or restore in tests.
 *
 * The handler is responsible for idempotency — transport may invoke it on
 * every 401 in a burst of concurrent requests.
 */
export function setUnauthorizedHandler(
  handler: ((err: UnauthorizedError) => void) | null,
): ((err: UnauthorizedError) => void) | null {
  const prev = unauthorizedHandler;
  unauthorizedHandler = handler;
  return prev;
}

function notifyUnauthorized(err: UnauthorizedError): void {
  if (unauthorizedHandler) unauthorizedHandler(err);
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    retryOnCsrfFailure = true,
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

    let builtAuthHeaders: Record<string, string>;
    try {
      builtAuthHeaders = authHeaders();
    } catch (err) {
      // authHeaders() throws UnauthorizedError when the stored token blob is
      // malformed. Surface via the registered handler and return the same
      // envelope shape the 401 path uses, so callers don't need a special case.
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
      if (err instanceof UnauthorizedError) {
        notifyUnauthorized(err);
        return { data: null as T, error: { code: 'UNAUTHORIZED', message: err.message } };
      }
      throw err;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        // credentials: 'include' so the session cookie rides along on every request.
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...builtAuthHeaders,
          ...csrfHeaders(method),
          ...options.headers,
        },
        signal: controller.signal,
      });
    } catch {
      const abortedByTimeout = controller.signal.aborted && !upstreamSignal?.aborted;
      const message = abortedByTimeout
        ? 'Request timed out. Check that the API server and upstream service are reachable.'
        : 'Cannot reach the Rounds API. Check that the API server is running.';
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
        // Notify the registered auth-boundary handler — it decides whether
        // to clear local storage and redirect. Transport stays free of DOM
        // and storage side effects so it remains node-testable. The DEV-only
        // console.warn keeps the local-dev signal that something needs
        // attention (likely a missing or expired backend session).
        if (import.meta.env.DEV) {
          console.warn('[api] 401 from', path);
        }
        const err = new UnauthorizedError(`401 from ${path}`);
        notifyUnauthorized(err);
        return { data: null as T, error: { code: 'UNAUTHORIZED', message: err.message } };
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
      if (retryOnCsrfFailure && res.status === 403 && error.code === 'CSRF_FAILED') {
        return this.request<T>(path, options, false);
      }
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
