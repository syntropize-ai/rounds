/**
 * In-memory implementation of `IAlertRuleRepository`.
 *
 * Test fixture only. Per ADR-001 the canonical persistence abstraction is the
 * repository, and the legacy `AlertRuleStore` has been retired. This module
 * preserves the original store's in-memory behavior under the repository
 * interface so existing tests + agent-core integration tests can keep
 * exercising rule logic without spinning up SQLite.
 *
 * Behavior parity with the SQLite repo:
 *   - `create()` defaults `source` to 'manual' (matches `writable-gate.ts`)
 *   - `transition()` appends history rows and applies pendingSince /
 *     lastFiredAt / fireCount side-effects exactly as
 *     `SqliteAlertRuleRepository.transition()` does
 *   - `getFolderUid()` falls back to a `folderUid` label, matching the
 *     agent-created rule convention
 *   - History buffer caps at 10_000 entries to bound memory growth
 */

import { randomUUID } from 'node:crypto';
import type {
  AlertRule,
  AlertRuleState,
  AlertHistoryEntry,
  AlertSilence,
  NotificationPolicy,
  SilenceStatus,
} from '@agentic-obs/common';
import type {
  IAlertRuleRepository,
  AlertRuleFindAllOptions,
} from '../interfaces.js';

export class InMemoryAlertRuleRepository implements IAlertRuleRepository {
  private rules = new Map<string, AlertRule>();
  private history: AlertHistoryEntry[] = [];
  private silences = new Map<string, AlertSilence>();
  private policies = new Map<string, NotificationPolicy>();
  private readonly workspaces = new Map<string, string>();

  async getFolderUid(_orgId: string, ruleId: string): Promise<string | null> {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;
    return rule.folderUid ?? rule.labels?.['folderUid'] ?? null;
  }

  async create(
    data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>,
  ): Promise<AlertRule> {
    const now = new Date().toISOString();
    const rule: AlertRule = {
      ...data,
      source: data.source ?? 'manual',
      id: `alert_${randomUUID().slice(0, 12)}`,
      state: 'normal',
      stateChangedAt: now,
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    if (data.workspaceId)
      this.workspaces.set(rule.id, data.workspaceId);
    return rule;
  }

  async findById(id: string): Promise<AlertRule | undefined> {
    return this.rules.get(id);
  }

  async findAll(filter?: AlertRuleFindAllOptions): Promise<{ list: AlertRule[]; total: number }> {
    let list = [...this.rules.values()];
    if (filter?.state)
      list = list.filter((r) => r.state === filter.state);
    if (filter?.severity)
      list = list.filter((r) => r.severity === filter.severity);
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      list = list.filter((r) =>
        r.name.toLowerCase().includes(q)
        || r.description.toLowerCase().includes(q)
        || Object.values(r.labels ?? {}).some((v) => v.toLowerCase().includes(q)),
      );
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const total = list.length;
    if (filter?.offset)
      list = list.slice(filter.offset);
    if (filter?.limit)
      list = list.slice(0, filter.limit);
    return { list, total };
  }

  async findByWorkspace(workspaceId: string): Promise<AlertRule[]> {
    return [...this.rules.values()].filter(
      (r) => (r.workspaceId ?? this.workspaces.get(r.id)) === workspaceId,
    );
  }

  async update(
    id: string,
    patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>,
  ): Promise<AlertRule | undefined> {
    const rule = this.rules.get(id);
    if (!rule)
      return undefined;
    const updated = { ...rule, ...patch, updatedAt: new Date().toISOString() };
    this.rules.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  async transition(
    id: string,
    newState: AlertRuleState,
    value?: number,
  ): Promise<AlertRule | undefined> {
    const rule = this.rules.get(id);
    if (!rule)
      return undefined;
    const oldState = rule.state;
    if (oldState === newState)
      return rule;

    const now = new Date().toISOString();
    const entry: AlertHistoryEntry = {
      id: randomUUID(),
      ruleId: id,
      ruleName: rule.name,
      fromState: oldState,
      toState: newState,
      value: value ?? 0,
      threshold: rule.condition.threshold,
      timestamp: now,
      labels: rule.labels ?? {},
    };
    this.history.push(entry);
    if (this.history.length > 10_000)
      this.history.splice(0, this.history.length - 10_000);

    const patch: Partial<AlertRule> = {
      state: newState,
      stateChangedAt: now,
      lastEvaluatedAt: now,
    };
    if (newState === 'pending')
      patch.pendingSince = now;
    if (newState === 'firing') {
      patch.lastFiredAt = now;
      patch.fireCount = rule.fireCount + 1;
      patch.pendingSince = undefined;
    }
    if (newState === 'normal' || newState === 'resolved')
      patch.pendingSince = undefined;

    return this.update(id, patch);
  }

  async getHistory(ruleId: string, limit = 50): Promise<AlertHistoryEntry[]> {
    return this.history
      .filter((h) => h.ruleId === ruleId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  async getAllHistory(limit = 100): Promise<AlertHistoryEntry[]> {
    return [...this.history]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  async createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): Promise<AlertSilence> {
    const silence: AlertSilence = {
      ...data,
      id: `silence_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    this.silences.set(silence.id, silence);
    return silence;
  }

  async findSilences(): Promise<AlertSilence[]> {
    const now = new Date().toISOString();
    return [...this.silences.values()]
      .filter((s) => s.endsAt > now)
      .map((s) => ({ ...s, status: this.computeSilenceStatus(s) }));
  }

  async findAllSilencesIncludingExpired(): Promise<AlertSilence[]> {
    return [...this.silences.values()]
      .map((s) => ({ ...s, status: this.computeSilenceStatus(s) }));
  }

  async updateSilence(
    id: string,
    patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>,
  ): Promise<AlertSilence | undefined> {
    const silence = this.silences.get(id);
    if (!silence)
      return undefined;
    const updated: AlertSilence = { ...silence, ...patch };
    this.silences.set(id, updated);
    return { ...updated, status: this.computeSilenceStatus(updated) };
  }

  async deleteSilence(id: string): Promise<boolean> {
    return this.silences.delete(id);
  }

  private computeSilenceStatus(silence: AlertSilence): SilenceStatus {
    const now = new Date().toISOString();
    if (silence.endsAt < now)
      return 'expired';
    if (silence.startsAt > now)
      return 'pending';
    return 'active';
  }

  async createPolicy(
    data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationPolicy> {
    const now = new Date().toISOString();
    const policy: NotificationPolicy = {
      ...data,
      id: `policy_${randomUUID().slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(policy.id, policy);
    return policy;
  }

  async findAllPolicies(): Promise<NotificationPolicy[]> {
    return [...this.policies.values()];
  }

  async findPolicyById(id: string): Promise<NotificationPolicy | undefined> {
    return this.policies.get(id);
  }

  async updatePolicy(
    id: string,
    patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>,
  ): Promise<NotificationPolicy | undefined> {
    const policy = this.policies.get(id);
    if (!policy)
      return undefined;
    const updated = { ...policy, ...patch, updatedAt: new Date().toISOString() };
    this.policies.set(id, updated);
    return updated;
  }

  async deletePolicy(id: string): Promise<boolean> {
    return this.policies.delete(id);
  }
}
