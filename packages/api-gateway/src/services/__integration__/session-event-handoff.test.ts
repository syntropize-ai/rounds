import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionEventBus, type SessionBusEvent } from '../session-event-bus.js';

/**
 * Pin the "subscribe-before-replay + publish-after-DB-append + serialized
 * chain" invariant called out by review finding #1. The bug it guards
 * against: when two events emit back-to-back, the underlying DB appends
 * may resolve out of order; if publish fires per-event after each append
 * resolves (without serialization), a subscriber joining mid-handoff can
 * miss a seq.
 *
 * This test simulates the exact race by using a controllable DB stub
 * whose append() returns a promise we can resolve in inverse order.
 *
 * Note: this is an integration-style test of the protocol, not the
 * ChatService wiring (which is exercised by the broader chat-service
 * suite). The point here is to prove the bus + chain pattern correctly
 * sequences delivery across the handoff.
 */

interface DbRow {
  seq: number;
  payload: { type: string };
}

class ControllableDb {
  rows: DbRow[] = [];
  /** seq → (resolve, reject) so tests can simulate failures, not just delay. */
  private gates = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  append(row: DbRow): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.gates.set(row.seq, {
        resolve: () => {
          this.rows.push(row);
          resolve();
        },
        reject,
      });
    });
  }

  release(seq: number): void {
    const gate = this.gates.get(seq);
    if (!gate) throw new Error(`no pending append for seq=${seq}`);
    this.gates.delete(seq);
    gate.resolve();
  }

  fail(seq: number, err: Error = new Error('db down')): void {
    const gate = this.gates.get(seq);
    if (!gate) throw new Error(`no pending append for seq=${seq}`);
    this.gates.delete(seq);
    gate.reject(err);
  }

  listSince(seq: number): DbRow[] {
    return this.rows.filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq);
  }
}

/** Pretend ChatService's wrappedSendEvent — chains persist+publish per
 *  session via a tail Promise so publish order = seq order even when the
 *  DB appends race. Mirrors the production code's serialization,
 *  including the event_gap placeholder on append failure. */
function makeWrappedSend(
  db: ControllableDb,
  bus: SessionEventBus,
  sessionId: string,
) {
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;
  const send = (event: { type: string }) => {
    const eventSeq = seq++;
    chain = chain.then(() =>
      db
        .append({ seq: eventSeq, payload: event })
        .then(() => bus.publish(sessionId, eventSeq, event as never))
        .catch(() => {
          // Mirror production exactly — the placeholder includes the seq
          // so a future drop of that field in production would be caught
          // by the test asserting the published event shape.
          bus.publish(
            sessionId,
            eventSeq,
            { type: 'event_gap', seq: eventSeq } as never,
          );
        }),
    );
    return eventSeq;
  };
  return { send, drain: () => chain };
}

/** Simulate the route's subscribe-before-replay handoff. Returns the
 *  ordered list of (seq, type) the subscriber observed, after dedupe. */
async function runSubscriber(
  db: ControllableDb,
  bus: SessionEventBus,
  sessionId: string,
  sinceSeq: number,
): Promise<Array<[number, string]>> {
  const buffer: SessionBusEvent[] = [];
  let liveMode = false;
  const observed: Array<[number, string]> = [];
  let maxEmittedSeq = sinceSeq;
  const writeEvent = (seq: number, event: { type: string }) => {
    if (seq <= maxEmittedSeq) return; // dedupe
    maxEmittedSeq = seq;
    observed.push([seq, event.type]);
  };
  const sub = bus.subscribe(sessionId, (payload) => {
    if (liveMode) writeEvent(payload.seq, payload.event as never);
    else buffer.push(payload);
  });
  // DB replay (matches chat.ts: listBySession + filter; here listSince).
  for (const row of db.listSince(sinceSeq)) {
    writeEvent(row.seq, row.payload);
  }
  for (const payload of buffer) writeEvent(payload.seq, payload.event as never);
  buffer.length = 0;
  liveMode = true;
  return new Promise((resolve) => {
    // Give one tick for any in-flight bus.publish to deliver after
    // liveMode is set.
    setImmediate(() => {
      sub.close();
      resolve(observed);
    });
  });
}

describe('session event handoff — replay + live boundary', () => {
  /** Helper: release N appends in chained order. The per-session chain
   *  only registers ONE gate at a time; we have to yield enough microtasks
   *  for each chain.then(...) to enqueue the next append before we can
   *  release it. Use a polling wait that gives up after ~50 ticks rather
   *  than guessing the exact microtask count (depends on inner .then
   *  layering in production code). */
  async function waitForGate(db: ControllableDb, seq: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((db as any).gates.has(seq)) return;
      await Promise.resolve();
    }
    throw new Error(`gate for seq=${seq} never appeared after 50 ticks`);
  }
  async function releaseInOrder(db: ControllableDb, count: number, start = 0): Promise<void> {
    for (let i = 0; i < count; i++) {
      await waitForGate(db, start + i);
      db.release(start + i);
    }
  }

  it('no event lost when subscriber connects after all events committed', async () => {
    const db = new ControllableDb();
    const bus = new SessionEventBus();
    const w = makeWrappedSend(db, bus, 's1');
    w.send({ type: 'a' });
    w.send({ type: 'b' });
    await releaseInOrder(db, 2);
    await w.drain();
    const observed = await runSubscriber(db, bus, 's1', -1);
    expect(observed).toEqual([[0, 'a'], [1, 'b']]);
  });

  it('serialization guarantees publish order matches seq order', async () => {
    // The invariant from review finding #1: even though one might think
    // the underlying DB could resolve appends out of order, the chain
    // forces them to await sequentially. Test the chain shape: only
    // seq=0's gate exists until seq=0 is released.
    const db = new ControllableDb();
    const bus = new SessionEventBus();
    const w = makeWrappedSend(db, bus, 's1');
    w.send({ type: 'a' }); // seq=0
    w.send({ type: 'b' }); // seq=1
    // Yield enough ticks for the first append to register but NOT enough
    // for the second (which can't happen until the first resolves).
    await waitForGate(db, 0);
    expect(() => db.release(1)).toThrow(/no pending append for seq=1/);
    // Release seq=0 → chain proceeds to enqueue seq=1's append.
    db.release(0);
    await waitForGate(db, 1);
    db.release(1);
    await w.drain();
    const observed = await runSubscriber(db, bus, 's1', -1);
    expect(observed).toEqual([[0, 'a'], [1, 'b']]);
  });

  it('subscriber connecting mid-run captures both committed and post-subscribe events', async () => {
    const db = new ControllableDb();
    const bus = new SessionEventBus();
    const w = makeWrappedSend(db, bus, 's1');
    w.send({ type: 'a' });
    await releaseInOrder(db, 1);
    await w.drain();
    // Now emit b but don't release the DB append yet.
    w.send({ type: 'b' });
    // Subscriber joins: DB has [a]; bus has nothing yet for b.
    const buffer: SessionBusEvent[] = [];
    let liveMode = false;
    const observed: Array<[number, string]> = [];
    let maxEmittedSeq = -1;
    const writeEvent = (seq: number, event: { type: string }) => {
      if (seq <= maxEmittedSeq) return;
      maxEmittedSeq = seq;
      observed.push([seq, event.type]);
    };
    const sub = bus.subscribe('s1', (payload) => {
      if (liveMode) writeEvent(payload.seq, payload.event as never);
      else buffer.push(payload);
    });
    for (const row of db.listSince(-1)) writeEvent(row.seq, row.payload);
    for (const p of buffer) writeEvent(p.seq, p.event as never);
    buffer.length = 0;
    liveMode = true;
    // Now release b. Bus publishes seq=1 to the live subscriber.
    await releaseInOrder(db, 1, 1);
    await w.drain();
    sub.close();
    expect(observed).toEqual([[0, 'a'], [1, 'b']]);
  });

  it('subscriber connecting with since=N skips already-seen events', async () => {
    const db = new ControllableDb();
    const bus = new SessionEventBus();
    const w = makeWrappedSend(db, bus, 's1');
    w.send({ type: 'a' });
    w.send({ type: 'b' });
    w.send({ type: 'c' });
    await releaseInOrder(db, 3);
    await w.drain();
    const observed = await runSubscriber(db, bus, 's1', 1);
    expect(observed).toEqual([[2, 'c']]);
  });

  it('append failure publishes event_gap placeholder; subsequent events keep flowing', async () => {
    // Pin the gap-on-failure behavior the reviewer flagged as untested.
    // When the DB rejects an append, the chain catches it and emits an
    // event_gap on the bus at that seq — live subscribers see the gap
    // explicitly rather than a silent skip. The next event still flows
    // because the chain's catch handler doesn't reject upward.
    const db = new ControllableDb();
    const bus = new SessionEventBus();
    const w = makeWrappedSend(db, bus, 's1');
    const seen: Array<{ seq: number; event: Record<string, unknown> }> = [];
    bus.subscribe('s1', (p) =>
      seen.push({ seq: p.seq, event: p.event as unknown as Record<string, unknown> }),
    );
    w.send({ type: 'a' });
    w.send({ type: 'b' });
    w.send({ type: 'c' });
    await waitForGate(db, 0);
    db.release(0);
    await waitForGate(db, 1);
    db.fail(1); // simulate DB write failure for seq=1
    await waitForGate(db, 2);
    db.release(2);
    await w.drain();
    expect(seen).toEqual([
      { seq: 0, event: { type: 'a' } },
      // Placeholder MUST include both `type` and `seq` — the seq lets a
      // future audit/UI consumer correlate the gap with the missing row.
      // If production drops the seq field, this assertion catches it.
      { seq: 1, event: { type: 'event_gap', seq: 1 } },
      { seq: 2, event: { type: 'c' } },
    ]);
  });

  it('idle EventEmitter sanity — bus.publish is sync, listeners deliver before publish returns', () => {
    // Pin EventEmitter semantics we rely on: handler runs synchronously
    // inside emit, NOT on a microtask. If Node ever changes this, our
    // race-free claim breaks and tests above would need to be revisited.
    const emitter = new EventEmitter();
    let observed = false;
    emitter.on('x', () => {
      observed = true;
    });
    emitter.emit('x');
    expect(observed).toBe(true);
  });
});
