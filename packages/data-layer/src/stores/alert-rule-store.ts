import { randomUUID } from 'node:crypto';
import type {
  AlertRule,
  AlertRuleState,
  AlertHistoryEntry,
  AlertSilence,
  NotificationPolicy,
  SilenceStatus,
} from '@agentic-obs/common';
import type { Persistable } from './persistence.js';
import { markDirty } from './persistence.js';

export class AlertRuleStore implements Persistable {
  private rules = new Map<string, AlertRule>();
  private history: AlertHistoryEntry[] = [];
  private silences = new Map<string, AlertSilence>();
  private policies = new Map<string, NotificationPolicy>();
  private readonly workspaces = new Map<string, string>();
  private listeners: Array<(event: 'created' | 'updated' | 'deleted', rule: AlertRule) => void> = [];

  /**
   * Legacy in-memory store doesn't track folder placement.
   * Always returns null so RBAC resolvers fall back to org-scoped checks.
   */
  getFolderUid(_orgId: string, _ruleId: string): string | null {
    return null;
  }

  create(data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>): AlertRule {
    const now = new Date().toISOString();
    const rule: AlertRule = {
      ...data,
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
    markDirty();
    this.notify('created', rule);
    return rule;
  }

  findById(id: string): AlertRule | undefined {
    return this.rules.get(id);
  }

  findAll(filter?: {
    state?: AlertRuleState;
    severity?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): { list: AlertRule[]; total: number } {
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

  findByWorkspace(workspaceId: string): AlertRule[] {
    return [...this.rules.values()].filter(
      (r) => this.workspaces.get(r.id) === workspaceId,
    );
  }

  getWorkspaceId(id: string): string | undefined {
    return this.workspaces.get(id);
  }

  update(id: string, patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>): AlertRule | undefined {
    const rule = this.rules.get(id);
    if (!rule)
      return undefined;
    const updated = { ...rule, ...patch, updatedAt: new Date().toISOString() };
    this.rules.set(id, updated);
    markDirty();
    this.notify('updated', updated);
    return updated;
  }

  delete(id: string): boolean {
    const rule = this.rules.get(id);
    if (!rule)
      return false;
    this.rules.delete(id);
    markDirty();
    this.notify('deleted', rule);
    return true;
  }

  transition(id: string, newState: AlertRuleState, value?: number): AlertRule | undefined {
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

  getHistory(ruleId: string, limit = 50): AlertHistoryEntry[] {
    return this.history
      .filter((h) => h.ruleId === ruleId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  getAllHistory(limit = 100): AlertHistoryEntry[] {
    return this.history
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): AlertSilence {
    const silence: AlertSilence = {
      ...data,
      id: `silence_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    this.silences.set(silence.id, silence);
    markDirty();
    return silence;
  }

  findSilences(): AlertSilence[] {
    const now = new Date().toISOString();
    return [...this.silences.values()]
      .filter((s) => s.endsAt > now)
      .map((s) => ({ ...s, status: this.computeSilenceStatus(s) }));
  }

  findAllSilencesIncludingExpired(): AlertSilence[] {
    return [...this.silences.values()]
      .map((s) => ({ ...s, status: this.computeSilenceStatus(s) }));
  }

  updateSilence(id: string, patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>): AlertSilence | undefined {
    const silence = this.silences.get(id);
    if (!silence)
      return undefined;
    const updated: AlertSilence = { ...silence, ...patch };
    this.silences.set(id, updated);
    markDirty();
    return { ...updated, status: this.computeSilenceStatus(updated) };
  }

  deleteSilence(id: string): boolean {
    const result = this.silences.delete(id);
    if (result)
      markDirty();
    return result;
  }

  private computeSilenceStatus(silence: AlertSilence): SilenceStatus {
    const now = new Date().toISOString();
    if (silence.endsAt < now)
      return 'expired';
    if (silence.startsAt > now)
      return 'pending';
    return 'active';
  }

  createPolicy(data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>): NotificationPolicy {
    const now = new Date().toISOString();
    const policy: NotificationPolicy = {
      ...data,
      id: `policy_${randomUUID().slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(policy.id, policy);
    markDirty();
    return policy;
  }

  findAllPolicies(): NotificationPolicy[] {
    return [...this.policies.values()];
  }

  findPolicyById(id: string): NotificationPolicy | undefined {
    return this.policies.get(id);
  }

  updatePolicy(id: string, patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>): NotificationPolicy | undefined {
    const policy = this.policies.get(id);
    if (!policy)
      return undefined;
    const updated = { ...policy, ...patch, updatedAt: new Date().toISOString() };
    this.policies.set(id, updated);
    markDirty();
    return updated;
  }

  deletePolicy(id: string): boolean {
    const result = this.policies.delete(id);
    if (result)
      markDirty();
    return result;
  }

  onChange(cb: (event: 'created' | 'updated' | 'deleted', rule: AlertRule) => void): void {
    this.listeners.push(cb);
  }

  private notify(event: 'created' | 'updated' | 'deleted', rule: AlertRule): void {
    for (const cb of this.listeners) {
      try {
        cb(event, rule);
      } catch {
        // Listener errors must not prevent other listeners from running.
      }
    }
  }

  toJSON(): unknown {
    return {
      rules: [...this.rules.values()],
      history: this.history,
      silences: [...this.silences.values()],
      policies: [...this.policies.values()],
    };
  }

  loadJSON(data: unknown): void {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.rules)) {
      for (const r of d.rules as AlertRule[]) {
        if (r.id)
          this.rules.set(r.id, r);
      }
    }
    if (Array.isArray(d.history))
      this.history = d.history as AlertHistoryEntry[];
    if (Array.isArray(d.silences)) {
      for (const s of d.silences as AlertSilence[]) {
        if (s.id)
          this.silences.set(s.id, s);
      }
    }
    if (Array.isArray(d.policies)) {
      for (const p of d.policies as NotificationPolicy[]) {
        if (p.id)
          this.policies.set(p.id, p);
      }
    }
  }
}

export const defaultAlertRuleStore = new AlertRuleStore();
