/**
 * Alert Rule Evaluator - periodically evaluates user-defined alert rules
 * against Prometheus and manages the state machine:
 *
 *   Normal -> Pending -> Firing -> Resolved -> Normal
 *
 * The `forDuration` on each rule prevents transient spikes from triggering alerts.
 */

import { createLogger } from '@agentic-obs/common';
import type { AlertRule, AlertRuleState, AlertHistoryEntry } from '@agentic-obs/common';

const log = createLogger('alert-evaluator');

// -- Types --

export interface AlertEvent {
  ruleId: string;
  ruleName: string;
  severity: AlertRule['severity'];
  state: AlertRuleState;
  value: number;
  threshold: number;
  labels: Record<string, string>;
  timestamp: string;
  message: string;
}

export interface PromQLEvaluator {
  /** Execute a PromQL instant query and return the scalar result (or undefined if no data) */
  evaluate(query: string): Promise<number | undefined>;
}

export interface AlertRuleProvider {
  /** Get all enabled (non-disabled) rules */
  getActiveRules(): AlertRule[];
  /** Transition a rule's state */
  transition(id: string, newState: AlertRuleState, value?: number): AlertRule | undefined;
  /** Update lastEvaluatedAt */
  markEvaluated(id: string): void;
}

export interface AlertEvaluatorConfig {
  /** Default evaluation interval in ms (used when rule doesn't specify) */
  defaultIntervalMs?: number;
  /** Minimum interval between full evaluation cycles in ms */
  minCycleIntervalMs?: number;
}

const DEFAULTS = {
  defaultIntervalMs: 60_000,
  minCycleIntervalMs: 15_000,
} as const;

// -- Evaluator --

export class AlertRuleEvaluator {
  private readonly promql: PromQLEvaluator;
  private readonly provider: AlertRuleProvider;
  private readonly cfg: Required<AlertEvaluatorConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly alertListeners: Array<(event: AlertEvent) => void> = [];
  private readonly resolveListeners: Array<(event: AlertEvent) => void> = [];

  constructor(
    promql: PromQLEvaluator,
    provider: AlertRuleProvider,
    config: AlertEvaluatorConfig = {},
  ) {
    this.promql = promql;
    this.provider = provider;
    this.cfg = { ...DEFAULTS, ...config };
  }

  // -- Lifecycle --

  onAlert(listener: (event: AlertEvent) => void): void {
    this.alertListeners.push(listener);
  }

  onResolve(listener: (event: AlertEvent) => void): void {
    this.resolveListeners.push(listener);
  }

  start(): void {
    if (this.timer) return;
    void this.evaluateAll();
    this.timer = setInterval(() => void this.evaluateAll(), this.cfg.minCycleIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -- Evaluation --

  async evaluateAll(): Promise<AlertEvent[]> {
    const rules = this.provider.getActiveRules();
    const events: AlertEvent[] = [];

    for (const rule of rules) {
      try {
        const event = await this.evaluateRule(rule);
        if (event) {
          events.push(event);
          const listeners = event.state === 'firing' ? this.alertListeners : this.resolveListeners;
          for (const cb of listeners) {
            try {
              cb(event);
            } catch (err) {
              log.error({ err }, 'alert listener error');
            }
          }
        }
      } catch (err) {
        log.error({ err, ruleId: rule.id }, 'rule evaluation error');
      }
    }

    return events;
  }

  async evaluateRule(rule: AlertRule): Promise<AlertEvent | null> {
    // Execute PromQL query
    const value = await this.promql.evaluate(rule.condition.query);
    this.provider.markEvaluated(rule.id);

    if (value === undefined) {
      // No data - if currently pending/firing, resolve (no data = condition not met)
      if (rule.state === 'pending' || rule.state === 'firing') {
        return this.transitionAndEmit(rule, 'resolved', 0);
      }
      return null;
    }

    // Check condition
    const conditionMet = this.checkCondition(value, rule.condition.operator, rule.condition.threshold);
    return this.processStateTransition(rule, conditionMet, value);
  }

  /** Test a rule without changing state - returns current value and whether it would fire */
  async testRule(rule: Pick<AlertRule, 'condition'>): Promise<{ value: number | undefined; wouldFire: boolean }> {
    const value = await this.promql.evaluate(rule.condition.query);
    if (value === undefined) {
      return { value: undefined, wouldFire: false };
    }
    const wouldFire = this.checkCondition(value, rule.condition.operator, rule.condition.threshold);
    return { value, wouldFire };
  }

  // -- State machine --

  private processStateTransition(rule: AlertRule, conditionMet: boolean, value: number): AlertEvent | null {
    const now = Date.now();

    switch (rule.state) {
      case 'normal':
      case 'resolved': {
        if (conditionMet) {
          if ((rule.condition.forDurationSec ?? 0) === 0) {
            // No for duration - fire immediately
            return this.transitionAndEmit(rule, 'firing', value);
          }

          // Enter pending
          return this.transitionAndEmit(rule, 'pending', value);
        }

        // Stay normal (or move resolved -> normal)
        if (rule.state === 'resolved') {
          this.provider.transition(rule.id, 'normal', value);
        }

        return null;
      }

      case 'pending': {
        if (!conditionMet) {
          // Condition no longer met - back to normal
          return this.transitionAndEmit(rule, 'normal', value);
        }

        // Check if forDuration has elapsed
        const pendingSince = rule.pendingSince ? new Date(rule.pendingSince).getTime() : now;
        const elapsedMs = now - pendingSince;
        if (elapsedMs >= (rule.condition.forDurationSec ?? 0) * 1000) {
          // for duration satisfied - fire!
          return this.transitionAndEmit(rule, 'firing', value);
        }

        // Still pending - update lastEvaluatedAt but no state change
        return null;
      }

      case 'firing': {
        if (!conditionMet) {
          // Condition resolved
          return this.transitionAndEmit(rule, 'resolved', value);
        }

        // Still firing - no event
        return null;
      }

      default:
        return null;
    }
  }

  private transitionAndEmit(rule: AlertRule, newState: AlertRuleState, value: number): AlertEvent {
    this.provider.transition(rule.id, newState, value);

    const event: AlertEvent = {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      state: newState,
      value,
      threshold: rule.condition.threshold,
      labels: rule.labels,
      timestamp: new Date().toISOString(),
      message: this.buildMessage(rule, newState, value),
    };

    return event;
  }

  private checkCondition(value: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case '>':
        return value > threshold;
      case '<':
        return value < threshold;
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      default:
        return false;
    }
  }

  private buildMessage(rule: AlertRule, state: AlertRuleState, value: number): string {
    if (state === 'firing') {
      return `[FIRING] ${rule.name}: ${rule.condition.query} is ${value.toFixed(2)} (threshold: ${rule.condition.operator} ${rule.condition.threshold})`;
    }

    if (state === 'resolved') {
      return `[RESOLVED] ${rule.name}: condition no longer met (current: ${value.toFixed(2)})`;
    }

    if (state === 'pending') {
      return `[PENDING] ${rule.name}: condition met, waiting for ${rule.condition.forDurationSec}s`;
    }

    return `${rule.name}: ${state}`;
  }
}
