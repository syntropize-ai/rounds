/**
 * Alert Rule Evaluator - periodically evaluates user-defined alert rules
 * against Prometheus and manages the state machine:
 * * Normal -> Pending -> Firing -> Resolved -> Normal
 * * The `forDuration` on each rule prevents transient spikes from triggering alerts.
 */
import type { AlertRule, AlertRuleState } from '@agentic-obs/common';

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

export declare class AlertRuleEvaluator {
  private readonly promql;
  private readonly provider;
  private readonly cfg;
  private timer;
  private readonly alertListeners;
  private readonly resolveListeners;

  constructor(promql: PromQLEvaluator, provider: AlertRuleProvider, config?: AlertEvaluatorConfig);
  onAlert(listener: (event: AlertEvent) => void): void;
  onResolve(listener: (event: AlertEvent) => void): void;
  start(): void;
  stop(): void;
  evaluateAll(): Promise<AlertEvent[]>;
  evaluateRule(rule: AlertRule): Promise<AlertEvent | null>;
  /** Test a rule without changing state - returns current value and whether it would fire */
  testRule(rule: Pick<AlertRule, 'condition'>): Promise<{
    value: number | undefined;
    wouldFire: boolean;
  }>;
  private processStateTransition;
  private transitionAndEmit;
  private checkCondition;
  private buildMessage;
}