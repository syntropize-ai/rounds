/**
 * Chokepoint for any code path that runs an agent against an investigation row.
 *
 * Guarantees the investigation always reaches a terminal status
 * (`completed` or `failed`) — never leaves it stuck at `planning` /
 * `running` / etc. — even if the agent throws, hangs, or the process
 * misbehaves.
 *
 * Why this exists: the SSE stream (`investigation-stream-service.ts`)
 * only emits `investigation:complete` when status is one of the terminal
 * values. A crashed agent leaves the row in a pre-terminal state and the
 * UI spins forever ("调研中..."). Any orchestration path (auto-dispatch,
 * manual click, future replays) must funnel through this helper.
 *
 * Design:
 *   - try → run agent (with AbortSignal-driven timeout)
 *   - catch → mark failed, log error + stack
 *   - finally → look up the row's current status; if still pre-terminal,
 *     force-transition to completed (clean) or failed (error/timeout).
 *   - Idempotent: a second call after the row is already terminal is a
 *     no-op. Safe to also call repo.updateStatus elsewhere.
 */

import type { InvestigationStatus } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';

/** Status values the SSE stream treats as terminal. Keep in sync with
 *  `investigation-stream-service.ts#isTerminal`. */
const TERMINAL_STATUSES: ReadonlySet<InvestigationStatus> = new Set([
  'completed',
  'failed',
]);

/** Default upper bound on a single agent run. Picked to be longer than
 *  any reasonable investigation but short enough that a stuck agent
 *  doesn't leave the row at `running` for the rest of the day. */
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Minimal investigation-repo surface this helper needs. Any wider
 *  repo interface (sqlite / postgres / gateway-extended) satisfies it. */
export interface InvestigationStatusStore {
  findById(id: string): Promise<{ status: InvestigationStatus } | null>;
  updateStatus(
    id: string,
    status: InvestigationStatus,
  ): Promise<unknown>;
}

export interface RunInvestigationAgentOptions<T> {
  /** Repo used to read current status and write the terminal status. */
  investigations: InvestigationStatusStore;
  /**
   * Resolve which investigation row this run is bound to. Returns null
   * when the agent never created one (nothing to finalize). May be sync
   * or async; called once after the agent returns/throws so callers
   * that don't know the id up-front (auto-dispatcher discovers it from
   * the workspace listing) can plug in.
   */
  resolveInvestigationId: () => string | null | Promise<string | null>;
  /**
   * The actual agent invocation. Receives an AbortSignal that fires when
   * the timeout elapses; agents that honor it can shut down cleanly.
   * (We still finalize the row regardless of whether the agent honors
   * the signal — the timeout is enforced by `Promise.race` below.)
   */
  runAgent: (signal: AbortSignal) => Promise<T>;
  /** Override timeout. Defaults to {@link DEFAULT_AGENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Logger name for diagnostics; defaults to 'investigation-agent-runner'. */
  loggerName?: string;
  /** Extra context merged into log lines (e.g. ruleId, userId). */
  logContext?: Record<string, unknown>;
}

export interface RunInvestigationAgentResult<T> {
  /** The agent's return value, if it completed normally. */
  reply: T | null;
  /** The error that ended the run, if any. */
  error: Error | null;
  /** True when the run was aborted by the timeout. */
  timedOut: boolean;
  /** The terminal status the row was driven to (or already at). null
   *  when no investigation row was discovered to finalize. */
  finalStatus: InvestigationStatus | null;
  /** The id finalized, when known. */
  investigationId: string | null;
}

/**
 * Run an agent against an investigation with a guaranteed terminal-status
 * write. See file header for rationale.
 */
export async function runInvestigationAgent<T>(
  opts: RunInvestigationAgentOptions<T>,
): Promise<RunInvestigationAgentResult<T>> {
  const log = createLogger(opts.loggerName ?? 'investigation-agent-runner');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const ctx = opts.logContext ?? {};

  let reply: T | null = null;
  let error: Error | null = null;
  let timedOut = false;

  const controller = new AbortController();
  const timeoutHandle: NodeJS.Timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Don't keep the event loop alive just for the timeout.
  if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

  try {
    // Race the agent against the timeout. Whichever settles first wins;
    // the loser still gets cleaned up via the AbortController + finally.
    reply = await Promise.race<T>([
      opts.runAgent(controller.signal),
      new Promise<T>((_, reject) => {
        const onAbort = (): void => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(new Error(`Agent run timed out after ${timeoutMs}ms`));
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort);
      }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    log.error(
      { ...ctx, err: error.message, stack: error.stack, timedOut },
      'investigation agent run failed',
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Resolve the row id and finalize. Best-effort: a failure here is
  // logged but doesn't re-throw — the caller already knows the agent
  // outcome via `error`.
  let investigationId: string | null = null;
  let finalStatus: InvestigationStatus | null = null;
  try {
    investigationId = await opts.resolveInvestigationId();
  } catch (lookupErr) {
    log.warn(
      {
        ...ctx,
        err: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
      },
      'investigation id resolution failed; cannot finalize status',
    );
  }

  if (investigationId) {
    try {
      const current = await opts.investigations.findById(investigationId);
      if (!current) {
        log.warn(
          { ...ctx, investigationId },
          'investigation row vanished before finalize',
        );
      } else if (TERMINAL_STATUSES.has(current.status)) {
        // Idempotent: someone (the agent itself, a prior call) already
        // finalized. Don't overwrite a `completed` with `failed` or
        // vice-versa.
        finalStatus = current.status;
      } else {
        const next: InvestigationStatus = error ? 'failed' : 'completed';
        await opts.investigations.updateStatus(investigationId, next);
        finalStatus = next;
        log.info(
          { ...ctx, investigationId, from: current.status, to: next, timedOut },
          'investigation forced to terminal status',
        );
      }
    } catch (finalizeErr) {
      log.error(
        {
          ...ctx,
          investigationId,
          err: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
          stack: finalizeErr instanceof Error ? finalizeErr.stack : undefined,
        },
        'investigation finalize updateStatus threw',
      );
    }
  }

  return { reply, error, timedOut, finalStatus, investigationId };
}
