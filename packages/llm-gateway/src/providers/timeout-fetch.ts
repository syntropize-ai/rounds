/**
 * `fetch` wrapper that adds a default per-request timeout to provider HTTP
 * calls and composes it with any caller-supplied AbortSignal.
 *
 * Why this exists: provider `complete()` methods used to do
 *   `if (options.signal) fetchInit.signal = options.signal;`
 * and nothing else. Chat paths plumb a signal through (SSE-disconnect-
 * driven abort), but background paths — `runBackgroundAgent`, scheduled
 * investigations — pass no signal at all. When a provider stalls (slow
 * model, upstream gateway pause, TCP without keepalive) the fetch waits
 * forever and the entire react-loop hangs on one tool call with no
 * diagnostic in the log. Adding a sane default timeout converts that
 * silent hang into a structured `ProviderError({kind:'timeout'})` that
 * the gateway already knows to retry / surface.
 */

import { ProviderError } from '../types.js';

/**
 * Default per-request timeout. Long enough for the slowest reasoning
 * models (extended thinking, big context) to legitimately respond;
 * short enough that a stalled provider is recovered from before the
 * user gives up and reloads. Override per call via `options.timeoutMs`.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export interface TimedFetchOptions {
  /** Caller-supplied signal (SSE-disconnect aborts, manual cancel, etc.). */
  signal?: AbortSignal;
  /** Override the default timeout for this single call. */
  timeoutMs?: number;
}

/**
 * Combine a default timeout with an optional caller signal into one
 * AbortSignal. Returns the signal plus a cleanup that clears the timer
 * (call after fetch resolves to avoid leaking the setTimeout).
 */
export function makeTimedSignal(
  opts: TimedFetchOptions,
): { signal: AbortSignal; cleanup: () => void; isTimedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    isTimedOut: () => timedOut,
  };
}

/**
 * Wrap a fetch call with the timeout + caller-signal composition. On
 * timeout throws a `ProviderError({kind:'timeout'})` instead of the raw
 * `AbortError` — that's what `gateway.callWithRetry` treats as
 * retryable.
 */
export async function timedFetch(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  opts: TimedFetchOptions & { provider: string; displayName: string; timeoutMs?: number },
): Promise<Response> {
  const { signal, cleanup, isTimedOut } = makeTimedSignal(opts);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (isTimedOut()) {
      const ms = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
      throw new ProviderError(
        `${opts.displayName} complete timed out after ${ms}ms (no response from provider).`,
        { kind: 'timeout', provider: opts.provider, cause: err },
      );
    }
    throw err;
  } finally {
    cleanup();
  }
}
