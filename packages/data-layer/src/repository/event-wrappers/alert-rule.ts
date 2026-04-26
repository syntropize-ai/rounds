import { createLogger } from '@agentic-obs/common/logging';
import type { MaybeAsync, IAlertRuleRepository, AlertRuleFindAllOptions } from '../interfaces.js';

const log = createLogger('alert-rule-events');
import type {
  AlertRule,
  AlertRuleState,
  AlertHistoryEntry,
  AlertSilence,
  NotificationPolicy,
} from '@agentic-obs/common';

type ChangeListener = (event: 'created' | 'updated' | 'deleted', rule: AlertRule) => void;

/**
 * Wraps an IAlertRuleRepository with in-memory pub/sub (onChange()).
 * Delegates all persistence to the underlying repository and fires
 * events after successful writes.
 */
export class EventEmittingAlertRuleRepository implements IAlertRuleRepository {
  private readonly listeners: ChangeListener[] = [];

  constructor(private readonly repo: IAlertRuleRepository) {}

  async create(data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>): Promise<AlertRule> {
    const rule = await this.repo.create(data);
    this.notify('created', rule);
    return rule;
  }

  findById(id: string): MaybeAsync<AlertRule | undefined> {
    return this.repo.findById(id);
  }

  findAll(filter?: AlertRuleFindAllOptions): MaybeAsync<{ list: AlertRule[]; total: number }> {
    return this.repo.findAll(filter);
  }

  findByWorkspace(workspaceId: string): MaybeAsync<AlertRule[]> {
    return this.repo.findByWorkspace(workspaceId);
  }

  getFolderUid(orgId: string, ruleId: string): MaybeAsync<string | null> {
    return this.repo.getFolderUid(orgId, ruleId);
  }

  async update(id: string, patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>): Promise<AlertRule | undefined> {
    const updated = await this.repo.update(id, patch);
    if (updated) this.notify('updated', updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    // Fetch the rule before deleting so we can include it in the event
    const rule = await this.repo.findById(id);
    const deleted = await this.repo.delete(id);
    if (deleted && rule) this.notify('deleted', rule);
    return deleted;
  }

  async transition(id: string, newState: AlertRuleState, value?: number): Promise<AlertRule | undefined> {
    const updated = await this.repo.transition(id, newState, value);
    if (updated) this.notify('updated', updated);
    return updated;
  }

  // -- History (read-only, delegate directly)

  getHistory(ruleId: string, limit?: number): MaybeAsync<AlertHistoryEntry[]> {
    return this.repo.getHistory(ruleId, limit);
  }

  getAllHistory(limit?: number): MaybeAsync<AlertHistoryEntry[]> {
    return this.repo.getAllHistory(limit);
  }

  // -- Silences (no events needed)

  createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): MaybeAsync<AlertSilence> {
    return this.repo.createSilence(data);
  }

  findSilences(): MaybeAsync<AlertSilence[]> {
    return this.repo.findSilences();
  }

  findAllSilencesIncludingExpired(): MaybeAsync<AlertSilence[]> {
    return this.repo.findAllSilencesIncludingExpired();
  }

  updateSilence(id: string, patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>): MaybeAsync<AlertSilence | undefined> {
    return this.repo.updateSilence(id, patch);
  }

  deleteSilence(id: string): MaybeAsync<boolean> {
    return this.repo.deleteSilence(id);
  }

  // -- Notification Policies (no events needed)

  createPolicy(data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>): MaybeAsync<NotificationPolicy> {
    return this.repo.createPolicy(data);
  }

  findAllPolicies(): MaybeAsync<NotificationPolicy[]> {
    return this.repo.findAllPolicies();
  }

  findPolicyById(id: string): MaybeAsync<NotificationPolicy | undefined> {
    return this.repo.findPolicyById(id);
  }

  updatePolicy(id: string, patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>): MaybeAsync<NotificationPolicy | undefined> {
    return this.repo.updatePolicy(id, patch);
  }

  deletePolicy(id: string): MaybeAsync<boolean> {
    return this.repo.deletePolicy(id);
  }

  // -- Event subscription

  onChange(cb: ChangeListener): void {
    this.listeners.push(cb);
  }

  private notify(event: 'created' | 'updated' | 'deleted', rule: AlertRule): void {
    for (const cb of this.listeners) {
      try {
        cb(event, rule);
      } catch (err) {
        log.warn({ err }, 'alert rule change listener threw');
      }
    }
  }
}
