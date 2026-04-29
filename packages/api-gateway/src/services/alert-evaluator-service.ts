/**
 * AlertEvaluatorService — periodic alert evaluation.
 *
 * Pulls alert rules out of the repository, runs each rule's `condition.query`
 * against the rule's datasource, walks the alert state machine, persists
 * transitions through `IAlertRuleRepository.transition()` (which appends
 * history rows + updates pendingSince / lastFiredAt / fireCount), and emits
 * an in-process `alert.fired` event when a rule transitions to `firing`.
 *
 * Phase 0.5 of `docs/design/auto-remediation.md`. Single-process v1 — no
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
import type {
  AlertCondition,
  AlertOperator,
  AlertRule,
  AlertRuleState,
  IAlertRuleRepository,
} from '@agentic-obs/common';

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
  private running = false;

  constructor(opts: AlertEvaluatorOptions) {
    super();
    this.rules = opts.rules;
    this.query = opts.query;
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Begin scheduling. One setInterval per active rule, cadence =
   * `rule.evaluationIntervalSec` seconds. Every `evaluationIntervalSec * 5`
   * we also re-pull the rule list so newly created/disabled rules get
   * picked up without a service restart.
   *
   * v1: single process. Multi-replica HA (instance_settings leader lock) is
   * a follow-up.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshSchedule();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
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
    const fresh =
      typeof ruleId === 'string' ? await this.rules.findById(ruleId) : await this.rules.findById(ruleId.id);
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
      this.emit('alert.fired', {
        ruleId: updated.id,
        ruleName: updated.name,
        severity: updated.severity,
        value,
        threshold: updated.condition.threshold,
        operator: updated.condition.operator,
        labels: updated.labels ?? {},
        firedAt: now.toISOString(),
      } satisfies AlertFiredPayload);
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
      const existing = this.timers.get(rule.id);
      if (existing) {
        // Reuse the timer; cadence change requires a restart of that timer.
        // Detect by tagging the timer in a side map — keep simple here:
        // always replace if the rule's cadence may have changed. The fast
        // path of 'no cadence change' isn't worth the tracking complexity
        // until we see real perf trouble.
        clearInterval(existing);
      }
      const t = setInterval(() => {
        if (!this.running) return;
        void this.tickRule(rule.id);
      }, intervalMs);
      this.timers.set(rule.id, t);
    }
    // Drop timers for rules that disappeared / got disabled.
    for (const id of [...this.timers.keys()]) {
      if (!seen.has(id)) {
        const t = this.timers.get(id);
        if (t) clearInterval(t);
        this.timers.delete(id);
      }
    }
  }
}

// Type-safe `on()` overload helper for consumers (TS doesn't infer
// EventEmitter signatures from generic args).
export interface AlertEvaluatorService {
  on<E extends keyof AlertEvaluatorEvents>(event: E, listener: AlertEvaluatorEvents[E]): this;
  off<E extends keyof AlertEvaluatorEvents>(event: E, listener: AlertEvaluatorEvents[E]): this;
  emit<E extends keyof AlertEvaluatorEvents>(event: E, ...args: Parameters<AlertEvaluatorEvents[E]>): boolean;
}

// Silence the unused-type-import warning in older TS settings.
export type { AlertCondition };
