/// <reference types="vite/client" />
import type { ApiResponse, SSEMessage } from './types.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Build auth headers from localStorage JWT or API key */
  private authHeaders(): Record<string, string> {
    try {
      const raw = localStorage.getItem('agentic_obs_auth');
      if (raw) {
        const tokens = JSON.parse(raw) as { tokens?: { accessToken?: string } };
        if (tokens?.tokens?.accessToken) return { Authorization: `Bearer ${tokens.tokens.accessToken}` };
      }
    } catch {
      // ignore
    }
    // Fall back to API key from localStorage (set during setup or login)
    const apiKey = localStorage.getItem('api_key');
    if (apiKey) return { 'x-api-key': apiKey };
    return {};
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
        ...options.headers,
      },
      ...options,
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ code: 'UNKNOWN', message: res.statusText }));
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
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Stream request failed: ${res.statusText}`);
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
