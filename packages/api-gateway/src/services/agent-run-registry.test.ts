import { describe, it, expect, vi } from 'vitest';
import {
  AgentRunRegistry,
  RunAlreadyActiveError,
} from './agent-run-registry.js';

function mkRegistry(opts: Partial<ConstructorParameters<typeof AgentRunRegistry>[0]> = {}) {
  return new AgentRunRegistry({ completedTtlMs: 50, ...opts });
}

describe('AgentRunRegistry', () => {
  it('allocates a runId and AbortController on start', () => {
    const reg = mkRegistry();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(r.runId).toMatch(/^run_/);
    expect(r.sessionId).toBe('s1');
    expect(r.status).toBe('running');
    expect(r.controller.signal.aborted).toBe(false);
    expect(reg.get(r.runId)).toBe(r);
    reg.shutdown();
  });

  it('rejects a second concurrent run on the same session', () => {
    const reg = mkRegistry();
    reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(() =>
      reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' }),
    ).toThrow(RunAlreadyActiveError);
    reg.shutdown();
  });

  it('allows a new run only after releaseSession is called (not just markComplete)', () => {
    // markComplete reflects "response delivered to client" — the underlying
    // agent task may still be alive in the background. releaseSession is
    // the signal that the agent ACTUALLY finished and the per-session
    // seq counter is safe to reallocate. New start() must block until
    // releaseSession to prevent orphan-vs-new-run seq collisions.
    const reg = mkRegistry();
    const r1 = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r1.runId, 'aborted');
    expect(() =>
      reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' }),
    ).toThrow(RunAlreadyActiveError);
    reg.releaseSession(r1.runId);
    expect(() =>
      reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' }),
    ).not.toThrow();
    reg.shutdown();
  });

  it('activeRunFor returns the row even after markComplete (until releaseSession)', () => {
    // Inverse of the above from the activeRunFor angle — confirms the
    // route's pre-check correctly 409s while an orphan is still alive.
    const reg = mkRegistry();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r.runId, 'aborted');
    expect(reg.activeRunFor('s1')?.runId).toBe(r.runId);
    expect(reg.activeRunFor('s1')?.status).toBe('aborted');
    reg.releaseSession(r.runId);
    expect(reg.activeRunFor('s1')).toBeUndefined();
    reg.shutdown();
  });

  it('releaseSession is idempotent and safe after row TTL eviction', async () => {
    // After my fix, TTL eviction only starts at releaseSession. So the
    // "row already gone" state requires: releaseSession (starts TTL) →
    // wait for TTL → call releaseSession again. The 2nd call must be
    // a safe no-op since the row has been GC'd.
    const reg = mkRegistry({ completedTtlMs: 20 });
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r.runId, 'succeeded');
    reg.releaseSession(r.runId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reg.get(r.runId)).toBeUndefined();
    expect(() => reg.releaseSession(r.runId)).not.toThrow();
    reg.shutdown();
  });

  it('releaseSession only frees the index when the runId still owns it', () => {
    // Defensive against double-fire on a race: if a stale finally fires
    // for an old run after the session was already re-acquired by a new
    // run, the new run's index must NOT be cleared.
    const reg = mkRegistry();
    const r1 = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r1.runId, 'aborted');
    reg.releaseSession(r1.runId);
    const r2 = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    // Late `.finally` from r1 (after r2 started):
    reg.releaseSession(r1.runId);
    expect(reg.activeRunFor('s1')?.runId).toBe(r2.runId);
    reg.shutdown();
  });

  it('cancel() aborts the controller; full release requires markComplete + releaseSession', () => {
    const reg = mkRegistry();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(reg.cancel(r.runId)).toBe(true);
    expect(r.controller.signal.aborted).toBe(true);
    // Status doesn't auto-flip; the agent task observes the signal and
    // the route calls markComplete + (via .finally on the agent promise)
    // releaseSession. Simulate the route's full lifecycle:
    reg.markComplete(r.runId, 'aborted');
    // After markComplete the session is STILL occupied until the orphan
    // agent settles. This is the orphan-protection guarantee.
    expect(reg.activeRunFor('s1')?.runId).toBe(r.runId);
    reg.releaseSession(r.runId);
    expect(reg.activeRunFor('s1')).toBeUndefined();
    reg.shutdown();
  });

  it('cancel() is idempotent — second call returns false', () => {
    const reg = mkRegistry();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(reg.cancel(r.runId)).toBe(true);
    reg.markComplete(r.runId, 'aborted');
    reg.releaseSession(r.runId);
    expect(reg.cancel(r.runId)).toBe(false);
    reg.shutdown();
  });

  it('markComplete is idempotent — only first call wins', () => {
    const reg = mkRegistry();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r.runId, 'succeeded');
    reg.markComplete(r.runId, 'failed'); // ignored
    expect(reg.get(r.runId)?.status).toBe('succeeded');
    reg.shutdown();
  });

  it('GCs completed runs after releaseSession + TTL elapses (not markComplete + TTL)', async () => {
    // Row-eviction is gated on releaseSession, not markComplete, to avoid
    // the orphan-vs-TTL wedge: a long-running orphan whose row was GC'd
    // would leave activeBySession pointing at a missing runId, so start()
    // 409s but activeRunFor returns undefined — session permanently
    // unusable. By scheduling the TTL only at releaseSession we
    // guarantee the row outlives the index reference.
    const reg = mkRegistry({ completedTtlMs: 20 });
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r.runId, 'succeeded');
    // TTL has NOT been scheduled yet — wait double the TTL and confirm
    // the row is still present.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reg.get(r.runId)).toBeDefined();
    // Now release — TTL starts; row evicted after another TTL window.
    reg.releaseSession(r.runId);
    expect(reg.get(r.runId)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reg.get(r.runId)).toBeUndefined();
    reg.shutdown();
  });

  it('long-running orphan does not wedge the session via TTL eviction', async () => {
    // The exact bug the previous test guards against. Sequence:
    //   1. start() → cancel() → markComplete(aborted), index stays
    //   2. orphan agent doesn't honor abort and runs for >TTL
    //   3. Before this fix: TTL evicts row from `runs` map, but the
    //      stale runId stays in activeBySession. start() of a new run
    //      throws RunAlreadyActive on the stale id, activeRunFor returns
    //      undefined (row is gone) — session is permanently unusable.
    //   4. With the fix: TTL is only scheduled in releaseSession, so an
    //      unreleased orphan keeps its row alive indefinitely. When the
    //      orphan finally settles, releaseSession both clears the index
    //      AND schedules eviction.
    const reg = mkRegistry({ completedTtlMs: 20 });
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.cancel(r.runId);
    reg.markComplete(r.runId, 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 40)); // > TTL
    // Pre-fix: get() would be undefined here. With the fix: row alive.
    expect(reg.get(r.runId)).toBeDefined();
    expect(reg.activeRunFor('s1')?.runId).toBe(r.runId);
    // Orphan finally settles.
    reg.releaseSession(r.runId);
    expect(reg.activeRunFor('s1')).toBeUndefined();
    // New run on the same session works.
    const r2 = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(r2.runId).not.toBe(r.runId);
    reg.shutdown();
  });

  it('truncates oversized error messages to 500 chars', () => {
    const reg = mkRegistry();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.markComplete(r.runId, 'failed', { errorMessage: 'x'.repeat(2000) });
    expect(reg.get(r.runId)?.errorMessage?.length).toBe(500);
    reg.shutdown();
  });

  it('activeRunFor returns undefined for unknown or fully-released sessions', () => {
    const reg = mkRegistry();
    expect(reg.activeRunFor('nope')).toBeUndefined();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(reg.activeRunFor('s1')?.runId).toBe(r.runId);
    reg.markComplete(r.runId, 'succeeded');
    reg.releaseSession(r.runId);
    expect(reg.activeRunFor('s1')).toBeUndefined();
    reg.shutdown();
  });

  it('shutdown clears all rows and timers', () => {
    const reg = mkRegistry();
    reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    reg.start({ sessionId: 's2', orgId: 'org', ownerUserId: 'u1' });
    expect(reg.size()).toBe(2);
    reg.shutdown();
    expect(reg.size()).toBe(0);
  });

  it('uses injected now() for deterministic timestamps in tests', () => {
    const fixed = 1_700_000_000_000;
    const reg = new AgentRunRegistry({ now: () => fixed });
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    expect(r.startedAt).toBe(new Date(fixed).toISOString());
    reg.markComplete(r.runId, 'succeeded');
    expect(r.completedAt).toBe(new Date(fixed).toISOString());
    reg.shutdown();
  });
});

// Lightweight integration test against the bus contract: publish-after-DB
// is exercised by ChatService internally; here we sanity-check the registry
// + bus together so a future refactor doesn't accidentally couple them.
describe('AgentRunRegistry + SessionEventBus (smoke)', () => {
  it('the two modules are independent — they share nothing', async () => {
    const { SessionEventBus } = await import('./session-event-bus.js');
    const reg = mkRegistry();
    const bus = new SessionEventBus();
    const r = reg.start({ sessionId: 's1', orgId: 'org', ownerUserId: 'u1' });
    const seen: unknown[] = [];
    bus.subscribe('s1', (e) => seen.push(e));
    bus.publish('s1', 0, { type: 'thinking' } as never);
    expect(seen).toHaveLength(1);
    expect(r.controller.signal.aborted).toBe(false);
    vi.useRealTimers();
    reg.shutdown();
  });
});
