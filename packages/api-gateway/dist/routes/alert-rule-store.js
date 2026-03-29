import { randomUUID } from 'crypto';
import { markDirty } from '../persistence.js';
export class AlertRuleStore {
    rules = new Map();
    history = [];
    silences = new Map();
    policies = new Map();
    listeners = [];
    // -- Rules CRUD --
    create(data) {
        const now = new Date().toISOString();
        const rule = {
            ...data,
            id: `alert_${randomUUID().slice(0, 12)}`,
            state: 'normal',
            stateChangedAt: now,
            fireCount: 0,
            createdAt: now,
            updatedAt: now,
        };
        this.rules.set(rule.id, rule);
        markDirty();
        this.notify('created', rule);
        return rule;
    }
    findById(id) {
        return this.rules.get(id);
    }
    findAll(filter) {
        let list = [...this.rules.values()];
        if (filter?.state) {
            list = list.filter(r => r.state === filter.state);
        }
        if (filter?.severity) {
            list = list.filter(r => r.severity === filter.severity);
        }
        if (filter?.search) {
            const search = filter.search.toLowerCase();
            list = list.filter(r => r.name.toLowerCase().includes(search) ||
                r.condition.query.toLowerCase().includes(search) ||
                r.description.toLowerCase().includes(search) ||
                Object.values(r.labels).some(v => v.toLowerCase().includes(search)));
        }
        list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const total = list.length;
        if (filter?.offset) {
            list = list.slice(filter.offset);
        }
        if (filter?.limit) {
            list = list.slice(0, filter.limit);
        }
        return { rules: list, total };
    }
    update(id, patch) {
        const rule = this.rules.get(id);
        if (!rule) {
            return undefined;
        }
        const updated = { ...rule, ...patch, updatedAt: new Date().toISOString() };
        this.rules.set(id, updated);
        markDirty();
        this.notify('updated', updated);
        return updated;
    }
    delete(id) {
        const rule = this.rules.get(id);
        if (!rule) {
            return false;
        }
        this.rules.delete(id);
        markDirty();
        this.notify('deleted', rule);
        return true;
    }
    // -- State transitions --
    transition(id, newState, value) {
        const rule = this.rules.get(id);
        if (!rule) {
            return undefined;
        }
        const oldState = rule.state;
        if (oldState === newState) {
            return rule;
        }
        const now = new Date().toISOString();
        const entry = {
            id: randomUUID(),
            ruleId: id,
            ruleName: rule.name,
            fromState: oldState,
            toState: newState,
            value: value ?? 0,
            threshold: rule.condition.threshold,
            timestamp: now,
            labels: rule.labels
        };
        this.history.push(entry);
        // Keep history bounded
        if (this.history.length > 10000) {
            const patch = { ...entry, id: this.history.length - 10000 };
            this.history = this.history.slice(-10000);
        }
        const patch = {
            state: newState,
            stateChangedAt: now,
            lastEvaluatedAt: now,
        };
        if (newState === 'pending') {
            patch.pendingSince = now;
        }
        if (newState === 'firing') {
            patch.lastFiredAt = now;
            patch.fireCount = rule.fireCount + 1;
            patch.pendingSince = undefined;
        }
        if (newState === 'normal' || newState === 'resolved') {
            patch.pendingSince = undefined;
        }
        return this.update(id, patch);
    }
    getHistory(ruleId, limit = 50) {
        return this.history
            .filter(h => h.ruleId === ruleId)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit);
    }
    getAllHistory(limit = 100) {
        return this.history
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit);
    }
    // -- Silences --
    createSilence(data) {
        const silence = {
            ...data,
            id: `silence_${randomUUID().slice(0, 12)}`,
            createdAt: new Date().toISOString(),
        };
        this.silences.set(silence.id, silence);
        markDirty();
        return silence;
    }
    findAllSilences() {
        const now = new Date().toISOString();
        return [...this.silences.values()]
            .filter(s => !s.endsAt || s.endsAt > now)
            .map(s => ({ ...s, status: this.computeSilenceStatus(s) }));
    }
    findAllSilencesIncludingExpired() {
        return [...this.silences.values()]
            .map(s => ({ ...s, status: this.computeSilenceStatus(s) }));
    }
    findSilenceById(id) {
        return this.silences.get(id);
    }
    updateSilence(id, patch) {
        const silence = this.silences.get(id);
        if (!silence) {
            return undefined;
        }
        const updated = { ...silence, ...patch };
        this.silences.set(id, updated);
        markDirty();
        return { ...updated, status: this.computeSilenceStatus(updated) };
    }
    deleteSilence(id) {
        const result = this.silences.delete(id);
        if (result) {
            markDirty();
        }
        return result;
    }
    computeSilenceStatus(silence) {
        const now = new Date().toISOString();
        if (silence.endsAt < now) {
            return 'expired';
        }
        if (silence.startsAt > now) {
            return 'pending';
        }
        return 'active';
    }
    // -- Notification Policies --
    createPolicy(data) {
        const now = new Date().toISOString();
        const policy = {
            ...data,
            id: `notif_${randomUUID().slice(0, 12)}`,
            createdAt: now,
            updatedAt: now
        };
        this.policies.set(policy.id, policy);
        markDirty();
        return policy;
    }
    findAllPolicies() {
        return [...this.policies.values()];
    }
    findPolicyById(id) {
        return this.policies.get(id);
    }
    updatePolicy(id, patch) {
        const policy = this.policies.get(id);
        if (!policy) {
            return undefined;
        }
        const updated = { ...policy, ...patch, updatedAt: new Date().toISOString() };
        this.policies.set(id, updated);
        markDirty();
        return updated;
    }
    deletePolicy(id) {
        const result = this.policies.delete(id);
        if (result) {
            markDirty();
        }
        return result;
    }
    // -- Listeners --
    onChange(cb) {
        this.listeners.push(cb);
    }
    notify(event, rule) {
        for (const cb of this.listeners) {
            try {
                cb(event, rule);
            }
            catch { }
        }
    }
    toJSON() {
        return {
            rules: [...this.rules.values()],
            history: this.history,
            silences: [...this.silences.values()],
            policies: [...this.policies.values()],
        };
    }
    loadJSON(data) {
        const d = data;
        if (Array.isArray(d.rules)) {
            for (const r of d.rules) {
                if (r.id) {
                    this.rules.set(r.id, r);
                }
            }
        }
        if (Array.isArray(d.history)) {
            this.history = d.history;
        }
        if (Array.isArray(d.silences)) {
            for (const s of d.silences) {
                if (s.id) {
                    this.silences.set(s.id, s);
                }
            }
        }
        if (Array.isArray(d.policies)) {
            for (const p of d.policies) {
                if (p.id) {
                    this.policies.set(p.id, p);
                }
            }
        }
    }
}
// Singleton
export const defaultAlertRuleStore = new AlertRuleStore();
//# sourceMappingURL=alert-rule-store.js.map
