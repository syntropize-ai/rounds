/**
 * R-5 / T1.3: share-link expiry handling must distinguish expired from
 * not-found so the route layer can return a specific 410 / "this link
 * expired" response. Asserts both the result shape AND the structured
 * warn log fires on expiry (captured via a mocked createLogger).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('@agentic-obs/common/logging', async () => {
  const actual = await vi.importActual<typeof import('@agentic-obs/common/logging')>(
    '@agentic-obs/common/logging',
  );
  const stub: () => Record<string, unknown> = () => ({
    info: () => {},
    warn: warnSpy,
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: stub,
  });
  return { ...actual, createLogger: stub };
});

import { InMemoryShareLinkRepository } from '../share-store.js';

describe('InMemoryShareLinkRepository.findByTokenStatus — expiry vs not-found', () => {
  let store: InMemoryShareLinkRepository;

  beforeEach(() => {
    store = new InMemoryShareLinkRepository();
    warnSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockClear();
  });

  it('returns not_found for an unknown token', () => {
    const result = store.findByTokenStatus('does-not-exist');
    expect(result.kind).toBe('not_found');
  });

  it('returns ok with the link for a valid token', () => {
    const link = store.create({
      investigationId: 'inv-1',
      createdBy: 'user-1',
      expiresInMs: 60_000,
    });
    const result = store.findByTokenStatus(link.token);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.link.token).toBe(link.token);
      expect(result.link.investigationId).toBe('inv-1');
    }
  });

  it('returns expired (distinct from not_found) and warn-logs when token has elapsed', () => {
    const link = store.create({
      investigationId: 'inv-7',
      createdBy: 'user-1',
      expiresInMs: -1, // already expired
    });
    const result = store.findByTokenStatus(link.token);
    expect(result.kind).toBe('expired');

    // Structured warn fired with the right context fields.
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('token expired'),
    );
    expect(warnCall).toBeDefined();
    const ctx = warnCall![0] as Record<string, unknown>;
    expect(ctx.investigationId).toBe('inv-7');
    expect(ctx.token).toBe(link.token);

    // Subsequent lookups return not_found (record was purged).
    const after = store.findByTokenStatus(link.token);
    expect(after.kind).toBe('not_found');
  });
});
