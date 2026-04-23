/**
 * Repository interface for alert rules (W6 / T6.A3).
 *
 * Implementation lives in
 * `packages/data-layer/src/repository/sqlite/alert-rule.ts`.
 *
 * The repository owns four related aggregates that used to live together
 * in the in-memory `AlertRuleStore`:
 *
 *   - alert_rules             — primary rule entities + lifecycle state
 *   - alert_history           — append-only log of state transitions
 *   - alert_silences          — active and expired silence windows
 *   - notification_policies   — flat notification routing policies
 *
 * The `transition()` method MUST preserve the exact state-machine
 * behavior of the old in-memory store: same history rows emitted, same
 * pendingSince / lastFiredAt / fireCount side-effects. See the impl for
 * the state-by-state breakdown.
 */

import type {
  AlertRule,
  AlertRuleState,
  AlertHistoryEntry,
  AlertSilence,
  NotificationPolicy,
} from '../../models/alert.js';

export interface AlertRuleFindAllOptions {
  state?: AlertRuleState;
  severity?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface IAlertRuleRepository {
  // -- Rules ----------------------------------------------------------

  /** Create a new rule. Initial state is 'normal' with fireCount = 0. */
  create(
    data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>,
  ): Promise<AlertRule>;

  /** Read a single rule by id. Returns undefined when not found. */
  findById(id: string): Promise<AlertRule | undefined>;

  /**
   * List rules matching optional filters. `search` is a case-insensitive
   * substring match against name, description, and label values.
   * Results are ordered by updatedAt DESC. `total` reflects the count
   * before limit/offset pagination is applied.
   */
  findAll(filter?: AlertRuleFindAllOptions): Promise<{ list: AlertRule[]; total: number }>;

  /** List all rules bound to a given workspace. */
  findByWorkspace(workspaceId: string): Promise<AlertRule[]>;

  /** Partial update. Returns the updated rule or undefined if not found. */
  update(
    id: string,
    patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>,
  ): Promise<AlertRule | undefined>;

  /** Delete a rule. Returns true if a row was removed. Cascades to history. */
  delete(id: string): Promise<boolean>;

  /**
   * Drive the alert state machine. Appends a history row and applies
   * the appropriate side-effects:
   *   - newState 'pending'  → sets pendingSince = now
   *   - newState 'firing'   → sets lastFiredAt, fireCount += 1, clears pendingSince
   *   - newState 'normal'   → clears pendingSince
   *   - newState 'resolved' → clears pendingSince
   * A no-op transition (oldState === newState) returns the current rule
   * WITHOUT appending a history entry.
   */
  transition(
    id: string,
    newState: AlertRuleState,
    value?: number,
  ): Promise<AlertRule | undefined>;

  // -- History --------------------------------------------------------

  /** History for one rule, most-recent first. Default limit 50. */
  getHistory(ruleId: string, limit?: number): Promise<AlertHistoryEntry[]>;

  /** Global history across all rules, most-recent first. Default limit 100. */
  getAllHistory(limit?: number): Promise<AlertHistoryEntry[]>;

  // -- Silences -------------------------------------------------------

  createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): Promise<AlertSilence>;
  /** Active and pending silences (endsAt > now). Each row has `status` computed. */
  findSilences(): Promise<AlertSilence[]>;
  /** All silences including expired ones, with computed `status`. */
  findAllSilencesIncludingExpired(): Promise<AlertSilence[]>;
  updateSilence(
    id: string,
    patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>,
  ): Promise<AlertSilence | undefined>;
  deleteSilence(id: string): Promise<boolean>;

  // -- Notification Policies (flat) ----------------------------------

  createPolicy(
    data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationPolicy>;
  findAllPolicies(): Promise<NotificationPolicy[]>;
  findPolicyById(id: string): Promise<NotificationPolicy | undefined>;
  updatePolicy(
    id: string,
    patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>,
  ): Promise<NotificationPolicy | undefined>;
  deletePolicy(id: string): Promise<boolean>;
}
