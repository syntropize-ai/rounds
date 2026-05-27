/**
 * AgentRunRegistry — tracks in-flight chat agent runs that are decoupled
 * from any specific HTTP request.
 *
 * Lifecycle:
 *   - `start()` registers a new run with a fresh AbortController. Returns
 *     the runId so the caller can hand it back to the client.
 *   - The agent run is responsible for calling `markComplete()` (with the
 *     final status) when it finishes — successful, failed, or aborted.
 *   - `cancel(runId)` aborts the controller; the agent's awaited LLM call
 *     unwinds via the signal and the run reaches markComplete('aborted').
 *   - Completed runs are GC'd after `completedTtlMs` (default 5 min) so a
 *     just-disconnected subscriber still sees status, but the map doesn't
 *     grow unboundedly.
 *
 * The registry is in-process and in-memory. Server restart loses all
 * in-flight runs — DB-persisted events survive, but live tails can't
 * resume across restarts. Documented v1 limitation.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('agent-run-registry');

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface RunRecord {
  runId: string;
  sessionId: string;
  orgId: string;
  ownerUserId: string;
  startedAt: string;
  status: RunStatus;
  /** Set when status moves out of 'running'. */
  completedAt?: string;
  /** Truncated error message when status='failed'. */
  errorMessage?: string;
  /** Internal: signal to cancel the run. Not serialized. */
  controller: AbortController;
  /** Internal: timer that GCs this row after completion. */
  cleanupTimer?: NodeJS.Timeout;
}

export interface AgentRunRegistryOptions {
  /** How long after completion to keep the row around so late status pings
   *  still succeed. Default 5 minutes. */
  completedTtlMs?: number;
  /** Test injection point — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * In-process registry of detached agent runs. Singleton per api-gateway
 * process; wired up in domain-routes.
 */
export class AgentRunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  /** Reverse index so we can check "is there already a run on this session?"
   *  in O(1) when handling a new POST /chat. Cleared on completion + GC. */
  private readonly activeBySession = new Map<string, string>();
  private readonly completedTtlMs: number;
  private readonly now: () => number;

  constructor(opts: AgentRunRegistryOptions = {}) {
    this.completedTtlMs = opts.completedTtlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register a new run. Caller is responsible for actually starting the
   * agent work — this method only allocates the runId + controller and
   * indexes the row.
   *
   * Throws if `sessionId` already has an active run; the caller should
   * 409 the request. Concurrent runs on one session would interleave
   * events and confuse subscribers.
   */
  start(args: {
    sessionId: string;
    orgId: string;
    ownerUserId: string;
  }): RunRecord {
    const existing = this.activeBySession.get(args.sessionId);
    if (existing) {
      // The index is the source of truth for "session occupied". markComplete
      // does NOT free the index — only releaseSession does, and that's
      // called when the agent task actually settles. So any present index
      // means an orphan is still alive (or just finished but not yet
      // released); a new run on the same session would race the orphan's
      // seq counter and produce interleaved/colliding events.
      throw new RunAlreadyActiveError(args.sessionId, existing);
    }
    const runId = `run_${randomUUID()}`;
    const record: RunRecord = {
      runId,
      sessionId: args.sessionId,
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      startedAt: new Date(this.now()).toISOString(),
      status: 'running',
      controller: new AbortController(),
    };
    this.runs.set(runId, record);
    this.activeBySession.set(args.sessionId, runId);
    return record;
  }

  /** Look up a run by id. Returns undefined when expired/GC'd. */
  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Look up the active run for a session. Returns the row whenever the
   *  session is indexed — INCLUDING when the row's status is no longer
   *  'running' but `releaseSession()` hasn't been called yet (the orphan
   *  agent is still alive in the background). Callers using this for the
   *  "can I start a new run?" decision should treat any return value as
   *  "busy". */
  activeRunFor(sessionId: string): RunRecord | undefined {
    const runId = this.activeBySession.get(sessionId);
    if (!runId) return undefined;
    return this.runs.get(runId);
  }

  /** Caller-initiated cancel. Idempotent. */
  cancel(runId: string): boolean {
    const row = this.runs.get(runId);
    if (!row) return false;
    if (row.status !== 'running') return false;
    try {
      row.controller.abort();
    } catch (err) {
      log.warn({ err, runId }, 'controller.abort threw');
    }
    return true;
  }

  /**
   * Move the run out of 'running' status. Called when the response has
   * been delivered to the client — either because the agent finished, or
   * because cancel was honored and the race-against-abort won.
   *
   * IMPORTANT: this does NOT free the session index. A cancel can leave
   * the underlying agent task alive in the background (Node can't kill an
   * uncooperative async function); that orphan still owns the per-session
   * seq space inside ChatService. Freeing the session before the orphan
   * has actually settled would let a new POST race the orphan and produce
   * interleaved/colliding seqs. Call `releaseSession()` ONLY when the
   * agent promise has truly resolved (success, throw, or natural
   * shutdown). Until then `activeRunFor()` keeps returning this row so
   * new POSTs 409 cleanly.
   *
   * Idempotent — only the first call wins.
   */
  markComplete(
    runId: string,
    status: Extract<RunStatus, 'succeeded' | 'failed' | 'aborted'>,
    opts: { errorMessage?: string } = {},
  ): void {
    const row = this.runs.get(runId);
    if (!row) return;
    if (row.status !== 'running') return;
    row.status = status;
    row.completedAt = new Date(this.now()).toISOString();
    if (opts.errorMessage) row.errorMessage = opts.errorMessage.slice(0, 500);
    // No TTL eviction here. We schedule the row's GC in releaseSession()
    // — see the comment there for why this matters (orphan agent + TTL
    // wedge bug otherwise).
  }

  /**
   * Free the session index AND schedule the row eviction. Caller MUST
   * only invoke this after the agent promise has actually settled —
   * otherwise the orphan agent and a new agent will collide on the
   * per-session seq counter inside ChatService.
   *
   * The row-eviction TTL is scheduled HERE (not in markComplete) so a
   * long-running orphan (one that ignores the abort signal for hours)
   * doesn't have its row GC'd out from under the still-occupied
   * activeBySession index — that combination was the "permanently
   * wedged session" bug flagged in adversarial review #2 round.
   *
   * Idempotent — safe to call multiple times.
   */
  releaseSession(runId: string): void {
    const row = this.runs.get(runId);
    if (!row) return;
    const indexed = this.activeBySession.get(row.sessionId);
    if (indexed === runId) this.activeBySession.delete(row.sessionId);
    // Schedule the row's eventual GC now. Once for the run's lifetime —
    // a second releaseSession call shouldn't reschedule.
    if (!row.cleanupTimer) {
      row.cleanupTimer = setTimeout(() => {
        this.runs.delete(runId);
      }, this.completedTtlMs);
      if (typeof row.cleanupTimer.unref === 'function') row.cleanupTimer.unref();
    }
  }

  /** Test helper: total tracked rows including completed-but-not-GC'd. */
  size(): number {
    return this.runs.size;
  }

  /** Stop all GC timers (test teardown only). */
  shutdown(): void {
    for (const row of this.runs.values()) {
      if (row.cleanupTimer) clearTimeout(row.cleanupTimer);
    }
    this.runs.clear();
    this.activeBySession.clear();
  }
}

export class RunAlreadyActiveError extends Error {
  constructor(public readonly sessionId: string, public readonly existingRunId: string) {
    super(
      `session ${sessionId} already has an active run (${existingRunId}); cancel it first or wait for it to finish`,
    );
    this.name = 'RunAlreadyActiveError';
  }
}
