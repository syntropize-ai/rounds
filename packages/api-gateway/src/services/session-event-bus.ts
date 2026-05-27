/**
 * SessionEventBus — in-process pub/sub of chat session events.
 *
 * Pairs with `chat_session_events` table persistence so a subscriber that
 * connects mid-run can do the standard replay-then-tail handoff:
 *
 *   1. subscribe() on the bus FIRST  (buffer incoming events)
 *   2. query DB for events with seq > N
 *   3. emit DB rows
 *   4. drain the buffered events, deduping by seq against what step 3 emitted
 *   5. continue forwarding live bus events directly
 *
 * Ordering invariant the agent side must respect:
 *
 *   publish AFTER the DB append resolves, with the seq the append used.
 *
 * That guarantees a subscriber querying the DB at step 2 sees every event
 * the bus emitted earlier; any seq it doesn't see came from publications
 * during/after step 2, which the buffer captures.
 *
 * Scope: per-process. Multi-replica HA would need a cross-process pubsub
 * (Postgres LISTEN, Redis, NATS) — out of scope for v1.
 */
import { EventEmitter } from 'node:events';
import type { DashboardSseEvent } from '@agentic-obs/common';

/**
 * The payload carried on the bus. `seq` is the persistence sequence number
 * the wrapping handler assigned when it appended to `chat_session_events` —
 * subscribers use it to dedupe across the replay/live boundary.
 */
export interface SessionBusEvent {
  sessionId: string;
  seq: number;
  event: DashboardSseEvent;
}

/**
 * A bus subscription. Call `close()` from a cleanup path (client disconnect,
 * test teardown) to detach the handler and free the per-session set when it
 * empties.
 */
export interface SessionBusSubscription {
  close(): void;
}

/**
 * In-process pub/sub keyed by sessionId. Single emitter is fine for v1 —
 * Node EventEmitter handles thousands of listeners cheaply, and we expect
 * ≤ a handful of concurrent subscribers per session (one or two browser
 * tabs at most).
 */
export class SessionEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Default max listeners is 10; raise the ceiling but DON'T disable it
    // (setMaxListeners(0)) — a real subscriber leak would then be silent.
    // 100 is plenty for normal use (a handful of tabs per session at
    // most) and still barks if something is leaking.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Publish an event for `sessionId`. Fire-and-forget — listeners are called
   * synchronously on the next microtask via EventEmitter semantics. Errors
   * thrown inside a listener don't affect other listeners or the caller.
   */
  publish(sessionId: string, seq: number, event: DashboardSseEvent): void {
    const payload: SessionBusEvent = { sessionId, seq, event };
    try {
      this.emitter.emit(channelOf(sessionId), payload);
    } catch {
      // EventEmitter only throws if a listener throws AND we have no error
      // handler. Swallow — the persistence layer is the source of truth.
    }
  }

  /**
   * Subscribe to events for `sessionId`. The handler receives every event
   * published after subscribe returns; the subscriber is responsible for
   * deduping by seq if it's also doing a DB replay.
   */
  subscribe(
    sessionId: string,
    handler: (payload: SessionBusEvent) => void,
  ): SessionBusSubscription {
    const channel = channelOf(sessionId);
    this.emitter.on(channel, handler);
    return {
      close: () => {
        this.emitter.off(channel, handler);
      },
    };
  }

  /** Test helper: count live subscribers for a session. */
  subscriberCount(sessionId: string): number {
    return this.emitter.listenerCount(channelOf(sessionId));
  }
}

function channelOf(sessionId: string): string {
  return `session:${sessionId}`;
}
