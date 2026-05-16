/**
 * Transport-layer tests focused on the 401 / unauthorized path.
 *
 * Regression guard for the P1 fix that moved redirect-on-401 and the
 * malformed-token-blob redirect out of the request hot path and the
 * `authHeaders()` header-decode path. Transport must NOT touch
 * `window.location` or `localStorage` itself — it raises via the
 * registered handler. These tests run in node (no `window`, no
 * `document`, no `localStorage`); the previous behaviour would have
 * crashed with `ReferenceError: window is not defined` on every 401.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiClient, UnauthorizedError, setUnauthorizedHandler } from './transport.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient — 401 handling (transport stays DOM-free)', () => {
  beforeEach(() => {
    // Node test env: `window` is genuinely undefined here. That is the
    // strongest possible assertion that transport touches no DOM — if it
    // tried to write `window.location.href` we'd get a ReferenceError.
    expect(typeof globalThis.window).toBe('undefined');
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on 401, returns UNAUTHORIZED envelope without throwing or touching DOM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401)));
    const client = new ApiClient('');
    const res = await client.get('/api/anything');
    expect(res.data).toBeNull();
    expect(res.error?.code).toBe('UNAUTHORIZED');
  });

  it('on 401, invokes the registered unauthorized handler with an UnauthorizedError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401)));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const client = new ApiClient('');
    await client.get('/api/a');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedError);
  });

  it('on 401, handler fires per-request (idempotency is the boundary handler\'s job)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401)));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const client = new ApiClient('');
    await Promise.all([client.get('/api/a'), client.get('/api/b'), client.get('/api/c')]);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('with no handler registered, 401 is inert (no crash, plain envelope)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401)));
    const client = new ApiClient('');
    const res = await client.get('/api/a');
    expect(res.error?.code).toBe('UNAUTHORIZED');
  });

  it('200 responses do not invoke the unauthorized handler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true }, 200)));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const client = new ApiClient('');
    await client.get('/api/a');
    expect(handler).not.toHaveBeenCalled();
  });
});
