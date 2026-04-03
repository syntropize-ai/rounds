import type { AlertRule, AlertRuleState, AlertHistoryEntry, AlertSilence, NotificationPolicy } from '@agentic-obs/common';
import type { Persistable } from '../persistence.js';
export declare class AlertRuleStore implements Persistable {
    private rules;
    private history;
    private silences;
    private policies;
    private listeners;
    create(data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>): AlertRule;
    findById(id: string): AlertRule | undefined;
    findAll(filter?: {
        state?: AlertRuleState;
        severity?: string;
        search?: string;
        limit?: number;
        offset?: number;
    }): {
        list: AlertRule[];
        total: number;
    };
    update(id: string, patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>): AlertRule | undefined;
    delete(id: string): boolean;
    transition(id: string, newState: AlertRuleState, value?: number): AlertRule | undefined;
    getHistory(ruleId: string, limit?: number): AlertHistoryEntry[];
    getAllHistory(limit?: number): AlertHistoryEntry[];
    createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): AlertSilence;
    findSilences(): AlertSilence[];
    findAllSilencesIncludingExpired(): AlertSilence[];
    updateSilence(id: string, patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>): AlertSilence | undefined;
    deleteSilence(id: string): boolean;
    private computeSilenceStatus;
    createPolicy(data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>): NotificationPolicy;
    findAllPolicies(): NotificationPolicy[];
    findPolicyById(id: string): NotificationPolicy | undefined;
    updatePolicy(id: string, patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>): NotificationPolicy | undefined;
    deletePolicy(id: string): boolean;
    onChange(cb: (event: 'created' | 'updated' | 'deleted', rule: AlertRule) => void): void;
    private notify;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
export declare const defaultAlertRuleStore: AlertRuleStore;
//# sourceMappingURL=alert-rule-store.d.ts.map