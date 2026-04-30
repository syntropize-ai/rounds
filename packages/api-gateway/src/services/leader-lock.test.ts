/**
 * Tests for LeaderLock against in-memory SQLite, exercising the
 * shared-DB race scenarios.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type SqliteClient } from '@agentic-obs/data-layer';
import { LeaderLock } from './leader-lock.js';

describe('LeaderLock', () => {
  let db: SqliteClient;
  let now: Date;

  beforeEach(() => {
    db = createTestDb();
    now = new Date('2026-04-30T00:00:00.000Z');
  });

  function lock(id: string, ttlMs = 30_000): LeaderLock {
    return new LeaderLock({
      db,
      key: 'alert_evaluator.leader',
      leaderId: id,
      ttlMs,
      clock: () => now,
    });
  }

  it('first claimer wins; second sees ok=false', async () => {
    const a = lock('a');
    const b = lock('b');
    expect((await a.tryAcquire()).ok).toBe(true);
    expect((await b.tryAcquire()).ok).toBe(false);
  });

  it('heartbeat extends the lease', async () => {
    const a = lock('a', 60_000);
    expect((await a.tryAcquire()).ok).toBe(true);

    // Move the clock close to expiry
    now = new Date(now.getTime() + 50_000);
    expect(await a.heartbeat()).toBe(true);

    // Another contender at this point sees a healthy lock
    now = new Date(now.getTime() + 30_000);  // still inside the renewed TTL (which now expires at +110s)
    const b = lock('b');
    expect((await b.tryAcquire()).ok).toBe(false);
  });

  it('expired lock can be taken over', async () => {
    const a = lock('a', 1000);
    expect((await a.tryAcquire()).ok).toBe(true);

    // Past the TTL without heartbeat
    now = new Date(now.getTime() + 5000);
    const b = lock('b');
    expect((await b.tryAcquire()).ok).toBe(true);

    // The original holder's heartbeat now fails because b owns it
    expect(await a.heartbeat()).toBe(false);
  });

  it('release relinquishes the lock', async () => {
    const a = lock('a');
    expect((await a.tryAcquire()).ok).toBe(true);
    await a.release();
    const b = lock('b');
    expect((await b.tryAcquire()).ok).toBe(true);
  });

  it('release by a non-holder is a no-op', async () => {
    const a = lock('a');
    expect((await a.tryAcquire()).ok).toBe(true);
    const b = lock('b');
    await b.release(); // we don't hold it
    expect(await a.heartbeat()).toBe(true);
  });

  it('heartbeat by a non-holder returns false without stomping the actual holder', async () => {
    const a = lock('a');
    expect((await a.tryAcquire()).ok).toBe(true);
    const b = lock('b');
    expect(await b.heartbeat()).toBe(false);
    // a still owns it
    expect(await a.heartbeat()).toBe(true);
  });

  it('two concurrent acquirers — only one wins', async () => {
    const a = lock('a');
    const b = lock('b');
    const [r1, r2] = await Promise.all([a.tryAcquire(), b.tryAcquire()]);
    const wins = [r1.ok, r2.ok].filter(Boolean).length;
    expect(wins).toBe(1);
  });
});
