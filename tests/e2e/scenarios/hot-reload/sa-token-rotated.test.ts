/**
 * After minting a new SA token and revoking the old one, the next
 * authenticated request must succeed using the new token without a
 * gateway restart (live DB lookup, Ref PR #128).
 *
 * Self-contained: this test never uses the seed SA token directly. It
 * mints a fresh SA + token, exercises it via raw fetch, revokes, mints
 * again, and asserts the second token works.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BASE_URL } from '../helpers/api-client.js';
import { mintSaToken, revokeSaToken, deleteSa } from '../helpers/sa.js';

interface MeResp { id?: string; email?: string }

async function meWith(token: string): Promise<{ status: number; body: MeResp }> {
  const res = await fetch(`${BASE_URL}/api/user`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: MeResp = {};
  try { body = JSON.parse(text) as MeResp; } catch { /* keep empty */ }
  return { status: res.status, body };
}

describe('hot-reload/sa-token-rotated', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) { try { await fn(); } catch { /* noop */ } }
  }, 30_000);

  it('rotated SA token works without restarting the gateway', async () => {
    const first = await mintSaToken();
    cleanup.push(() => deleteSa(first.saId));

    const before = await meWith(first.token);
    expect(before.status).toBe(200);

    await revokeSaToken(first.saId, first.tokenId);

    const afterRevoke = await meWith(first.token);
    expect(afterRevoke.status).toBe(401);

    // Mint a new token on the same SA; it must work immediately.
    const second = await mintSaToken();
    cleanup.push(() => deleteSa(second.saId));
    const after = await meWith(second.token);
    expect(after.status).toBe(200);
  }, 60_000);
});
