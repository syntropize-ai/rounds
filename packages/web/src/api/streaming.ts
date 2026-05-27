import type { SSEMessage } from './types.js';
import { authHeaders, csrfHeaders } from './headers.js';

/**
 * Open a long-lived GET SSE subscription. Unlike `postStream`, this is for
 * idempotent event subscriptions (no body, no side effects) — the kind of
 * stream you keep alive for a whole session's lifetime to tail live events.
 *
 * Parses standard SSE `id:` / `event:` / `data:` frames and calls `onEvent`
 * with each (id, eventType, rawData) tuple so the caller can use `id` as
 * a dedupe key when reconnecting (the SSE `Last-Event-ID` semantics).
 *
 * Auto-reconnects with exponential backoff up to MAX_RECONNECTS. On each
 * reconnect the caller's `getReconnectUrl` is called so the URL can carry
 * the last seen id (e.g. `?since={lastId}`).
 */
export async function subscribeStream(
  baseUrl: string,
  getReconnectUrl: () => string,
  onEvent: (id: string | null, eventType: string, rawData: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const MAX_RECONNECTS = 8; // higher than postStream — subscriptions live longer
  let attempt = 0;

  for (;;) {
    if (signal.aborted) return;
    const res = await fetch(`${baseUrl}${getReconnectUrl()}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      signal,
    });

    if (!res.ok || !res.body) {
      // 404 means the session was deleted server-side — give up rather
      // than reconnect-storming. Other failures still retry within budget.
      if (res.status === 404) return;
      if (attempt >= MAX_RECONNECTS) {
        throw new Error(
          `subscription failed: ${res.status} ${res.statusText} (max retries reached)`,
        );
      }
      attempt += 1;
      await backoff(attempt, signal);
      continue;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let currentId: string | null = null;
    let sawData = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          // Server closed the stream — could be intentional (idle close)
          // or transient. Retry within the budget.
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        // Strip CR before splitting so CRLF-terminated SSE (Windows
        // proxies, some load balancers) parses identically to LF.
        const lines = buffer.replace(/\r\n/g, '\n').split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('id:')) {
            currentId = line.slice(3).trim();
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            onEvent(currentId, currentEvent, data);
            // First data we've successfully received on this connection
            // — reset attempt so a long-lived stream that drops after
            // hours of healthy use starts its backoff escalation from 0
            // rather than from whatever the last failure left it at.
            if (!sawData) {
              attempt = 0;
              sawData = true;
            }
            currentEvent = 'message';
            currentId = null;
          } else if (line.trim() === '') {
            currentEvent = 'message';
            currentId = null;
          }
        }
      }
      // Server-side close → reconnect. Don't reset attempt counter — a
      // server that immediately closes again should escalate backoff
      // rather than loop at 1s forever (review finding: hot reconnect
      // storm risk).
      attempt += 1;
      if (attempt > MAX_RECONNECTS) {
        throw new Error(
          `subscription closed by server too many times (${MAX_RECONNECTS}); giving up`,
        );
      }
      await backoff(attempt, signal);
      continue;
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return;
      }
      attempt += 1;
      if (attempt > MAX_RECONNECTS) {
        throw new Error(
          `subscription lost: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await backoff(attempt, signal);
      continue;
    }
  }
}

async function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const ms = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let onAbort: (() => void) | null = null;
    const t = setTimeout(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    // { once: true } removes after firing, AND we remove from setTimeout
    // path above — covers both "timer wins" and "abort wins" cases so the
    // listener doesn't leak per backoff invocation.
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST a request and consume the response as a Server-Sent Events stream.
 * Calls onEvent for each SSE event frame received.
 * Pass an AbortSignal to cancel mid-stream.
 *
 * Resilience: if `reader.read()` throws mid-stream (e.g. transient network
 * drop), we attempt up to 3 reconnects with exponential backoff (1s, 2s,
 * 4s), sending a `Last-Event-ID` header on each reconnect per the SSE spec.
 * TODO: server-side resume support — the backend currently re-runs from
 * scratch instead of honoring Last-Event-ID, so reconnects produce a fresh
 * generation rather than resuming. Reconnect-from-scratch is still better
 * than silently dropping a half-emitted assistant turn.
 */
export async function postStream(
  baseUrl: string,
  path: string,
  body: unknown,
  onEvent: (eventType: string, rawData: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const MAX_RECONNECTS = 3;
  let attempt = 0;
  let lastEventId: string | null = null;

  for (;;) {
    const extraHeaders: Record<string, string> =
      lastEventId !== null ? { 'Last-Event-ID': lastEventId } : {};

    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
        ...csrfHeaders('POST'),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      if (res.status === 401) {
        // In dev mode the frontend skips login, but the backend still needs
        // a missing or expired backend session. Surface a clear message instead of
        // a cryptic "Network error".
        throw new Error('Authentication required — log in and try again.');
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

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('id:')) {
            lastEventId = line.slice(3).trim();
          } else if (line.startsWith('event:')) {
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
    } catch (err) {
      // Caller-initiated abort: don't reconnect.
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      attempt += 1;
      if (attempt > MAX_RECONNECTS) {
        const lastErrMsg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `SSE connection lost — reconnect attempts exhausted (${MAX_RECONNECTS}). Last error: ${lastErrMsg}`,
        );
      }
      const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
      console.warn(
        `[api] SSE stream interrupted (attempt ${attempt}/${MAX_RECONNECTS}); retrying in ${backoffMs}ms`,
        err,
      );
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, backoffMs);
        if (signal) {
          const onAbort = () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      // Loop back to retry with Last-Event-ID set.
      continue;
    }
  }
}

/**
 * Subscribe to a Server-Sent Events stream.
 * Returns a cleanup function to close the connection.
 */
export function sse<T = unknown>(
  baseUrl: string,
  path: string,
  onMessage: (msg: SSEMessage<T>) => void,
  onError?: (err: Event) => void,
): () => void {
  const source = new EventSource(`${baseUrl}${path}`);

  source.onmessage = (e: MessageEvent<string>) => {
    try {
      const data = JSON.parse(e.data) as T;
      onMessage({ event: 'message', data });
    } catch (err) {
      // Drop the frame, but log it so a misbehaving server (sending
      // malformed protocol frames) is debuggable in production. Truncate
      // raw frame to avoid flooding the console with huge payloads.
      const truncated = typeof e.data === 'string' && e.data.length > 200
        ? `${e.data.slice(0, 200)}...`
        : String(e.data);
      console.warn('[sse] dropped malformed frame:', truncated, err);
    }
  };

  source.addEventListener('error', (e) => {
    onError?.(e);
  });

  return () => source.close();
}
