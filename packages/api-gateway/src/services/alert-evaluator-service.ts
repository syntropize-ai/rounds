/**
 * AlertEvaluatorService — periodic alert evaluation.
 *
 * Pulls alert rules out of the repository, runs each rule's `condition.query`
 * against the rule's datasource, walks the alert state machine, persists
 * transitions through `IAlertRuleRepository.transition()` (which appends
 * history rows + updates pendingSince / lastFiredAt / fireCount), and emits
 * an in-process `alert.fired` event when a rule transitions to `firing`.
 *
 * Phase 0.5 of `auto-remediation design notes`. Single-process v1 — no
 * cross-replica leader lock yet (multi-replica HA is tracked as a follow-up;
 * the design doc explicitly scoped it out for v1).
 *
 * State machine, mirrored from the rule semantics in
 * `packages/common/src/models/alert.ts`:
 *
 *   normal/resolved + predicate true                       → pending
 *   pending + predicate true + duration ≥ forDurationSec   → firing
 *   pending + predicate false                              → normal
 *   firing  + predicate false                              → resolved
 *
 * Disabled rules are skipped. forDurationSec = 0 short-circuits pending and
 * goes straight to firing on the same tick.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '@agentic-obs/common/logging';
import {
  EventTypes,
  computeAlertFingerprint,
  createEvent,
  type IEventBus,
  type AlertFiredEventPayload,
} from '@agentic-obs/common/events';
import type { LeaderLock } from './leader-lock.js';
import type {
  AlertOperator,
  AlertRule,
  AlertRuleState,
} from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';

const log = createLogger('alert-evaluator');

/**
 * Run one rule's metric query. Returns the scalar value to compare against
 * the threshold, or `null` if the datasource produced no sample (we treat
 * that as "predicate cannot be evaluated" — current state stands).
 *
 * Caller-provided so this service can stay independent of any specific
 * MetricsAdapter wiring.
 */
export type MetricQueryFn = (rule: AlertRule) => Promise<number | null>;

/** Wall clock injected for tests. */
export type ClockFn = () => Date;

export interface AlertEvaluatorEvents {
  /**
   * Emitted whenever a rule transitions INTO `firing`. Payload includes
   * enough context for downstream subscribers (Phase 8: AutoInvestigationDispatcher)
   * to act without re-querying the rule.
   */
  'alert.fired': (payload: AlertFiredPayload) => void;
}

export interface AlertFiredPayload {
  ruleId: string;
  ruleName: string;
  severity: AlertRule['severity'];
  /** The numeric value at the moment of firing. */
  value: number;
  threshold: number;
  operator: AlertOperator;
  labels: Record<string, string>;
  firedAt: string;
}

export interface AlertEvaluatorOptions {
  rules: IAlertRuleRepository;
  query: MetricQueryFn;
  /** Defaults to `() => new Date()`. Tests inject a fake clock. */
  clock?: ClockFn;
  /**
   * Per-rule tick is scheduled at `rule.evaluationIntervalSec * 1000` ms.
   * `start()` registers a single setInterval per rule. `stop()` clears
   * everything.
   */
  defaultIntervalSec?: number;
  /**
   * Optional leader lock for multi-replica HA. When provided, `start()`
   * tries to acquire it before scheduling rules; if another replica
   * holds it, this instance waits. A heartbeat refreshes the lock; if we
   * lose it (e.g. paused process longer than TTL) the schedulers are
   * cleared and acquisition resumes. Single-process deploys can leave
   * this unset.
   */
  leaderLock?: LeaderLock;
  /**
   * How often to heartbeat / poll for leadership. Defaults to one third
   * of `leaderLock.ttlMs`. Has no effect when `leaderLock` is unset.
   */
  leaderHeartbeatMs?: number;
  /**
   * Periodic safety-net cadence — `refreshSchedule()` runs on this
   * interval regardless of event-driven signals. Catches missed events,
   * leader handoffs, and out-of-band DB writes (Mimir-style hybrid).
   * Defaults to 60_000 ms; tunable via `ALERT_EVALUATOR_REFRESH_MS`.
   */
  refreshIntervalMs?: number;
  /**
   * Debounce window for event-driven `refreshSchedule()` invocations,
   * coalescing bursts of rule create/update/delete events into a single
   * rebuild. Defaults to 250 ms.
   */
  refreshDebounceMs?: number;
  /**
   * Bus for publishing `alert.fired` events to consumers (auto-investigation
   * dispatcher, notification consumer, etc.). When provided, every fire is
   * published to `EventTypes.ALERT_FIRED` with the full
   * `AlertFiredEventPayload` shape (orgId + fingerprint included). The
   * legacy `EventEmitter.emit('alert.fired', …)` is also fired for
   * test compatibility.
   */
  eventBus?: IEventBus;
  /** Org id to stamp on bus events. Defaults to `'org_main'`. */
  orgId?: string;
}

/**
 * Decide the next state for a single rule given the current sample value.
 * Pure function — no I/O. Exposed for tests; `tickRule` calls it.
 */
export function decideTransition(
  rule: Pick<AlertRule, 'state' | 'pendingSince' | 'condition'>,
  predicateTrue: boolean,
  now: Date,
): AlertRuleState | null {
  const { state, pendingSince, condition } = rule;
  if (state === 'disabled') return null;

  if (predicateTrue) {
    if (state === 'firing') return null; // already firing — stay
    if (state === 'pending') {
      if (!pendingSince) return null;
      const elapsedMs = now.getTime() - new Date(pendingSince).getTime();
      if (elapsedMs >= condition.forDurationSec * 1000) return 'firing';
      return null;
    }
    // normal | resolved
    if (condition.forDurationSec === 0) return 'firing';
    return 'pending';
  }

  // predicate false
  if (state === 'firing') return 'resolved';
  if (state === 'pending') return 'normal';
  return null;
}

/**
 * Backtest input for {@link previewAlertCondition}. Pure data — no datasource
 * resolution; the caller resolves the metrics adapter.
 */
export interface PreviewAlertInput {
  query: string;
  operator: AlertOperator;
  threshold: number;
  /** Lookback window in hours; clamped to [1, 168]. */
  lookbackHours?: number;
  /** Step passed to rangeQuery (e.g. '60s'). Defaults to '60s'. */
  step?: string;
  /** Cap on returned sample timestamps. Defaults to 20. */
  maxSamples?: number;
}

export type PreviewAlertResult =
  | {
      kind: 'ok';
      wouldHaveFired: number;
      sampleTimestamps: string[];
      seriesCount: number;
      lookbackHours: number;
      reason?: 'no_series';
    }
  | { kind: 'missing_capability'; reason: string };

/** Minimal metrics-adapter shape this helper depends on. */
interface RangeQuerier {
  rangeQuery(
    expr: string,
    start: Date,
    end: Date,
    step: string,
  ): Promise<Array<{ metric: Record<string, string>; values: Array<[number, string]> }>>;
}

/**
 * Backtest an alert condition over the recent past. Counts how many sample
 * points across all returned series would have satisfied the predicate, and
 * returns up to `maxSamples` representative timestamps.
 *
 * Surgical contract: NO state-machine semantics (`forDurationSec`, debounce)
 * are simulated here — this is a coarse "would the predicate have been true"
 * count, sufficient for the UI/AI preview pane. Modeling forDuration would
 * require per-series time-aware sliding windows; out of scope for v1 preview.
 */
export async function previewAlertCondition(
  metrics: RangeQuerier | undefined | null,
  input: PreviewAlertInput,
  now: Date = new Date(),
): Promise<PreviewAlertResult> {
  if (!metrics) {
    return { kind: 'missing_capability', reason: 'no_metrics_datasource' };
  }
  const lookbackHours = Math.max(1, Math.min(168, input.lookbackHours ?? 24));
  const end = now;
  const start = new Date(end.getTime() - lookbackHours * 3_600_000);
  const step = input.step ?? '60s';
  const maxSamples = Math.max(1, input.maxSamples ?? 20);

  let series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
  try {
    series = await metrics.rangeQuery(input.query, start, end, step);
  } catch (err) {
    return {
      kind: 'missing_capability',
      reason: `query_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!series || series.length === 0) {
    return {
      kind: 'ok',
      wouldHaveFired: 0,
      sampleTimestamps: [],
      seriesCount: 0,
      lookbackHours,
      reason: 'no_series',
    };
  }

  const matches: number[] = [];
  let wouldHaveFired = 0;
  for (const s of series) {
    for (const [tsSec, raw] of s.values) {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      if (evaluatePredicate(input.operator, v, input.threshold)) {
        wouldHaveFired += 1;
        if (matches.length < maxSamples) matches.push(tsSec);
      }
    }
  }

  return {
    kind: 'ok',
    wouldHaveFired,
    sampleTimestamps: matches.map((sec) => new Date(sec * 1000).toISOString()),
    seriesCount: series.length,
    lookbackHours,
  };
}

/** Pure predicate evaluator. */
export function evaluatePredicate(operator: AlertOperator, value: number, threshold: number): boolean {
  switch (operator) {
    case '>':  return value > threshold;
    case '>=': return value >= threshold;
    case '<':  return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default: {
      const _exhaustive: never = operator;
      throw new Error(`unknown alert operator: ${String(_exhaustive)}`);
    }
  }
}

export class AlertEvaluatorService extends EventEmitter {
  private readonly rules: IAlertRuleRepository;
  private readonly query: MetricQueryFn;
  private readonly clock: ClockFn;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly scheduleFingerprints = new Map<string, string>();
  private readonly leaderLock?: LeaderLock;
  private readonly leaderHeartbeatMs: number;
  private readonly refreshIntervalMs: number;
  private readonly refreshDebounceMs: number;
  private readonly eventBus?: IEventBus;
  private readonly orgId: string;
  private leaderTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private readonly inFlightRules = new Set<string>();
  private isLeader = false;
  private running = false;

  // Typed event helpers. Method overrides here (not declaration merging)
  // keep the @typescript-eslint/no-unsafe-declaration-merging rule happy.
  override on<E extends keyof AlertEvaluatorEvents>(
    event: E,
    listener: AlertEvaluatorEvents[E],
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override off<E extends keyof AlertEvaluatorEvents>(
    event: E,
    listener: AlertEvaluatorEvents[E],
  ): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  override emit<E extends keyof AlertEvaluatorEvents>(
    event: E,
    ...args: Parameters<AlertEvaluatorEvents[E]>
  ): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  constructor(opts: AlertEvaluatorOptions) {
    super();
    this.rules = opts.rules;
    this.query = opts.query;
    this.clock = opts.clock ?? (() => new Date());
    this.leaderLock = opts.leaderLock;
    this.leaderHeartbeatMs =
      opts.leaderHeartbeatMs ??
      (this.leaderLock ? Math.max(1000, Math.floor(this.leaderLock.ttlMs / 3)) : 0);
    this.refreshIntervalMs = Math.max(
      1_000,
      opts.refreshIntervalMs ?? (Number(process.env['ALERT_EVALUATOR_REFRESH_MS']) || 60_000),
    );
    this.refreshDebounceMs = Math.max(0, opts.refreshDebounceMs ?? 250);
    this.eventBus = opts.eventBus;
    this.orgId = opts.orgId ?? 'org_main';
  }

  /**
   * Notify the evaluator that the rule set may have changed (create /
   * update / delete on the rule store). Coalesces bursts via a short
   * debounce so 5 rapid creates rebuild the schedule once.
   *
   * No-op while not running or while we don't hold leadership — the
   * periodic safety net or a future leader-claim will pick the change up.
   */
  notifyRuleChanged(): void {
    if (!this.running || !this.isLeader) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refreshSchedule().catch((err) => {
        this.logBackgroundError(err, 'alert evaluator refreshSchedule failed');
      });
    }, this.refreshDebounceMs);
  }

  /**
   * Begin scheduling. One setInterval per active rule, cadence =
   * `rule.evaluationIntervalSec` seconds. Every `evaluationIntervalSec * 5`
   * we also re-pull the rule list so newly created/disabled rules get
   * picked up without a service restart.
   *
   * When a leaderLock is configured, evaluation only runs while we hold
   * the lock. The acquire-or-wait poll is run on the same heartbeat
   * cadence as the lease renewal — a non-leader replica polls cheaply
   * until the current leader's lease expires.
   */
  async start(): Promise<void> {
    if (this.running) return;
    // Listener-before-emitter discipline: the boot sequence is supposed
    // to subscribe the AutoInvestigationDispatcher BEFORE calling start().
    // A missing listener at this point usually means a regression in
    // alerts-boot wiring; warn loudly in dev/test so the race is caught
    // pre-prod. Don't throw — operators may legitimately run without
    // auto-investigation.
    if (process.env['NODE_ENV'] !== 'production' && this.listenerCount('alert.fired') === 0) {
      log.warn(
        {},
        'AlertEvaluatorService.start() called with zero alert.fired listeners. ' +
        'If auto-investigation is intended to be enabled, the dispatcher must be ' +
        'subscribed BEFORE start() to avoid losing the first tick\'s events.',
      );
    }
    this.running = true;
    if (this.leaderLock) {
      this.leaderTimer = setInterval(() => {
        if (!this.running) return;
        void this.tickLeader().catch((err) => {
          this.logBackgroundError(err, 'alert evaluator tickLeader failed');
        });
      }, this.leaderHeartbeatMs);
      // Best-effort eager attempt so the first claim doesn't wait one
      // heartbeat interval.
      await this.tickLeader();
    } else {
      this.isLeader = true;
      await this.refreshSchedule();
    }
    // Periodic safety-net: re-pull rules every refreshIntervalMs so
    // missed events / out-of-band DB writes still get scheduled.
    this.refreshTimer = setInterval(() => {
      if (!this.running || !this.isLeader) return;
      void this.refreshSchedule().catch((err) => {
        this.logBackgroundError(err, 'alert evaluator refreshSchedule failed');
      });
    }, this.refreshIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.leaderTimer) {
      clearInterval(this.leaderTimer);
      this.leaderTimer = undefined;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.scheduleFingerprints.clear();
    if (this.leaderLock && this.isLeader) {
      // fire-and-forget; release errors are not fatal
      void this.leaderLock.release().catch(() => undefined);
    }
    this.isLeader = false;
  }

  /**
   * Re-evaluate leadership. If we're not leader, try to acquire; if we
   * are, heartbeat. State changes are mirrored on the per-rule timers.
   */
  private async tickLeader(): Promise<void> {
    if (!this.leaderLock) return;
    if (this.isLeader) {
      const stillMine = await this.leaderLock.heartbeat();
      if (!stillMine) {
        log.warn({}, 'alert evaluator lost leader lock; clearing schedulers');
        this.isLeader = false;
        for (const t of this.timers.values()) clearInterval(t);
        this.timers.clear();
        this.scheduleFingerprints.clear();
      }
      return;
    }
    const got = await this.leaderLock.tryAcquire();
    if (got.ok) {
      log.info({}, 'alert evaluator acquired leader lock; starting schedulers');
      this.isLeader = true;
      await this.refreshSchedule();
    }
  }

  /**
   * Run one evaluation pass over every active rule. Exposed for tests; the
   * scheduler version is `start()`.
   */
  async tickAll(): Promise<void> {
    const result = await this.rules.findAll();
    for (const rule of result.list) {
      if (rule.state === 'disabled') continue;
      try {
        await this.tickRule(rule);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), ruleId: rule.id },
          'tickRule threw',
        );
      }
    }
  }

  /**
   * Evaluate a single rule and persist any state transition.
   *
   * - Fetches the latest copy of the rule from the repo so concurrent
   *   updates (e.g. user disables, transitioning since last list) aren't
   *   stomped.
   * - On `null` from the query (no sample), no transition: ambiguous
   *   predicates leave state alone.
   */
  async tickRule(ruleId: AlertRule | string): Promise<void> {
    const id = typeof ruleId === 'string' ? ruleId : ruleId.id;
    if (this.inFlightRules.has(id)) {
      log.debug({ ruleId: id }, 'skipping overlapping alert evaluation tick');
      return;
    }
    this.inFlightRules.add(id);
    try {
      const fresh = await this.rules.findById(id);
      if (!fresh || fresh.state === 'disabled') return;

      const value = await this.query(fresh);
      if (value === null) return;

      const predicate = evaluatePredicate(
        fresh.condition.operator,
        value,
        fresh.condition.threshold,
      );

      const now = this.clock();
      const next = decideTransition(fresh, predicate, now);
      if (next === null || next === fresh.state) return;

      const updated = await this.rules.transition(fresh.id, next, value);
      if (next === 'firing' && updated) {
        const labels = updated.labels ?? {};
        const firedAt = now.toISOString();
        // Local emit kept for in-process test consumers; the bus publish
        // below is the production fan-out path.
        this.emit('alert.fired', {
          ruleId: updated.id,
          ruleName: updated.name,
          severity: updated.severity,
          value,
          threshold: updated.condition.threshold,
          operator: updated.condition.operator,
          labels,
          firedAt,
        } satisfies AlertFiredPayload);
        if (this.eventBus) {
          const payload: AlertFiredEventPayload = {
            ruleId: updated.id,
            ruleName: updated.name,
            orgId: this.orgId,
            severity: updated.severity,
            value,
            threshold: updated.condition.threshold,
            operator: updated.condition.operator,
            labels,
            firedAt,
            fingerprint: computeAlertFingerprint(updated.id, labels),
          };
          await this.eventBus.publish(
            EventTypes.ALERT_FIRED,
            createEvent(EventTypes.ALERT_FIRED, payload),
          );
        }
      }
    } finally {
      this.inFlightRules.delete(id);
    }
  }

  /**
   * Re-pull rules and (re)schedule per-rule timers. Old timers for rules
   * that no longer exist are cleared. Called from `start()` and may be
   * called again at runtime to pick up rule changes.
   */
  async refreshSchedule(): Promise<void> {
    if (!this.running) return;
    const result = await this.rules.findAll();
    const seen = new Set<string>();
    for (const rule of result.list) {
      if (rule.state === 'disabled') continue;
      seen.add(rule.id);
      const intervalSec = rule.evaluationIntervalSec || 60;
      const intervalMs = intervalSec * 1000;
      const fingerprint = this.scheduleFingerprint(rule, intervalMs);
      const existing = this.timers.get(rule.id);
      if (existing && this.scheduleFingerprints.get(rule.id) === fingerprint) {
        continue;
      }
      if (existing) {
        clearInterval(existing);
      }
      const t = setInterval(() => {
        if (!this.running) return;
        void this.tickRule(rule.id).catch((err) => {
          this.logBackgroundError(err, 'alert evaluator tickRule failed', { ruleId: rule.id });
        });
      }, intervalMs);
      this.timers.set(rule.id, t);
      this.scheduleFingerprints.set(rule.id, fingerprint);
    }
    // Drop timers for rules that disappeared / got disabled.
    for (const id of [...this.timers.keys()]) {
      if (!seen.has(id)) {
        const t = this.timers.get(id);
        if (t) clearInterval(t);
        this.timers.delete(id);
        this.scheduleFingerprints.delete(id);
      }
    }
  }

  private scheduleFingerprint(rule: AlertRule, intervalMs: number): string {
    return `${intervalMs}:${rule.state}`;
  }

  private logBackgroundError(
    err: unknown,
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    log.error(
      {
        ...extra,
        err: err instanceof Error ? err.message : String(err),
      },
      message,
    );
  }
}
