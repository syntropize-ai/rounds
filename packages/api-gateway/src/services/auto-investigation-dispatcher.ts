/**
 * AutoInvestigationDispatcher — when a rule transitions into `firing`,
 * automatically kick off an investigation that diagnoses why.
 *
 * Phase 8 of `docs/design/auto-remediation.md`. Subscribes to the
 * AlertEvaluatorService's `alert.fired` event and dispatches a background
 * orchestrator run via `runBackgroundAgent`. The agent runs as a
 * service-account identity resolved from a configured SA token; it has
 * no human-side capabilities (cannot approve plans, etc.).
 *
 * Dedup: same ruleId within the dedup window only spawns one
 * investigation. v1 uses an in-memory LRU; multi-replica HA needs a
 * persistent marker on the rule row — tracked as a follow-up.
 *
 * The dispatcher does NOT own the alert event source — it's handed an
 * `AlertEvaluatorService` (or any EventEmitter that emits the
 * `alert.fired` shape). Stop/start is just `subscribe()` + `unsubscribe()`,
 * matching the lifecycle the api-gateway boot sequence expects.
 */

import type { EventEmitter } from 'node:events';
import { createLogger } from '@agentic-obs/common/logging';
import {
  runBackgroundAgent,
  type BackgroundRunnerDeps,
} from '@agentic-obs/agent-core';
import type { AlertFiredPayload } from './alert-evaluator-service.js';

const log = createLogger('auto-investigation');

/** Default dedup window if the caller doesn't supply one. */
const DEFAULT_DEDUP_MS = 5 * 60 * 1000;

export interface AutoInvestigationDispatcherOptions {
  /** Source of `alert.fired` events. AlertEvaluatorService satisfies this. */
  alertEvents: EventEmitter;
  /** Service-account token resolver + orchestrator factory. */
  runner: BackgroundRunnerDeps;
  /** Raw SA token (`openobs_sa_...`) used to authenticate the auto-investigations. */
  saToken: string;
  /**
   * Same ruleId firing within this window is deduped. Defaults to 5 minutes;
   * pass `forDurationSec * 2 * 1000` for tighter alignment to the rule.
   */
  dedupMs?: number;
  /** Override for tests. */
  clock?: () => Date;
  /**
   * Override the spawned background-agent function — useful in tests so we
   * don't have to stand up a real orchestrator. Defaults to
   * `runBackgroundAgent`.
   */
  spawnAgent?: typeof runBackgroundAgent;
}

/** Compose a question string from an alert payload. */
export function buildAlertQuestion(payload: AlertFiredPayload): string {
  const opPretty = payload.operator;
  const labelsBit = Object.keys(payload.labels).length > 0
    ? ` (labels: ${Object.entries(payload.labels).map(([k, v]) => `${k}=${v}`).join(', ')})`
    : '';
  return [
    `Alert "${payload.ruleName}" (${payload.severity}) is firing${labelsBit}.`,
    `Condition: value ${opPretty} ${payload.threshold}; current ${payload.value}.`,
    'Investigate the root cause and propose a fix if one is in scope.',
  ].join(' ');
}

export class AutoInvestigationDispatcher {
  private readonly listener: (payload: AlertFiredPayload) => void;
  private readonly recent = new Map<string, number>(); // ruleId -> ms timestamp
  private readonly dedupMs: number;
  private readonly clock: () => Date;
  private readonly spawnAgent: typeof runBackgroundAgent;
  private subscribed = false;

  constructor(private readonly opts: AutoInvestigationDispatcherOptions) {
    this.dedupMs = opts.dedupMs ?? DEFAULT_DEDUP_MS;
    this.clock = opts.clock ?? (() => new Date());
    this.spawnAgent = opts.spawnAgent ?? runBackgroundAgent;
    this.listener = (payload) => { void this.onAlertFired(payload); };
  }

  /** Begin listening. Idempotent — calling twice does not double-subscribe. */
  subscribe(): void {
    if (this.subscribed) return;
    this.opts.alertEvents.on('alert.fired', this.listener);
    this.subscribed = true;
  }

  unsubscribe(): void {
    if (!this.subscribed) return;
    this.opts.alertEvents.off('alert.fired', this.listener);
    this.subscribed = false;
  }

  /**
   * Handle one alert.fired event. Public for tests; production callers go
   * through `subscribe()`.
   */
  async onAlertFired(payload: AlertFiredPayload): Promise<void> {
    const now = this.clock().getTime();
    const last = this.recent.get(payload.ruleId);
    if (last !== undefined && now - last < this.dedupMs) {
      log.debug({ ruleId: payload.ruleId, deltaMs: now - last }, 'auto-investigation deduped');
      return;
    }
    this.recent.set(payload.ruleId, now);
    this.gcRecent(now);

    try {
      const reply = await this.spawnAgent(this.opts.runner, {
        saToken: this.opts.saToken,
        message: buildAlertQuestion(payload),
      });
      log.info(
        { ruleId: payload.ruleId, ruleName: payload.ruleName, replyHead: reply.slice(0, 120) },
        'auto-investigation completed',
      );
    } catch (err) {
      // Crash isolation: one failed investigation must not stop the
      // dispatcher from handling future alerts.
      log.error(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'auto-investigation failed',
      );
    }
  }

  /** Drop dedup entries older than the window so the map doesn't grow unbounded. */
  private gcRecent(now: number): void {
    for (const [k, v] of this.recent) {
      if (now - v >= this.dedupMs) this.recent.delete(k);
    }
  }
}
