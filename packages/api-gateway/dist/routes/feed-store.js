import { randomUUID } from 'crypto';
export class FeedStore {
    items = new Map();
    orderedIds = [];
    subscribers = new Set();
    tenants = new Map();
    add(type, title, summary, severity, investigationId, tenantId) {
        const item = {
            id: randomUUID(),
            type,
            title,
            summary,
            severity,
            status: 'unread',
            investigationId,
            createdAt: new Date().toISOString(),
        };
        this.items.set(item.id, item);
        this.orderedIds.push(item.id);
        if (tenantId) {
            this.tenants.set(item.id, tenantId);
        }
        this.notify(item);
        return item;
    }
    get(id) {
        return this.items.get(id);
    }
    list(options = {}) {
        const { page = 1, limit = 20, type, severity, status, tenantId } = options;
        let filtered = this.orderedIds
            .map(id => this.items.get(id))
            .filter(item => item !== undefined)
            .reverse();
        if (tenantId !== undefined) {
            filtered = filtered.filter(item => this.tenants.get(item.id) === tenantId);
        }
        if (type !== undefined) {
            filtered = filtered.filter(item => item.type === type);
        }
        if (severity !== undefined) {
            filtered = filtered.filter(item => item.severity === severity);
        }
        if (status !== undefined) {
            filtered = filtered.filter(item => item.status === status);
        }
        const total = filtered.length;
        const start = (page - 1) * limit;
        const items = filtered.slice(start, start + limit);
        return { items, total, page, limit };
    }
    markRead(id) {
        const item = this.items.get(id);
        if (!item) {
            return undefined;
        }
        const updated = { ...item, status: 'read' };
        this.items.set(id, updated);
        return updated;
    }
    /**
     * Mark a feed item as followed-up (user navigated from feed into investigation).
     * Idempotent: calling again when already true is a no-op.
     */
    markFollowedUp(id) {
        const item = this.items.get(id);
        if (!item) {
            return undefined;
        }
        if (item.followed_up) {
            return item;
        }
        const updated = { ...item, followed_up: true };
        this.items.set(id, updated);
        return updated;
    }
    addFeedback(id, feedback, comment) {
        const item = this.items.get(id);
        if (!item) {
            return undefined;
        }
        const updated = {
            ...item,
            feedback,
            ...(comment !== undefined ? { feedbackComment: comment } : {}),
        };
        this.items.set(id, updated);
        return updated;
    }
    /**
     * Record or update a per-hypothesis verdict for a feed item.
     * If feedback for the same hypothesisId already exists it is replaced.
     */
    addHypothesisFeedback(id, feedback) {
        const item = this.items.get(id);
        if (!item) {
            return undefined;
        }
        const existing = item.hypothesisFeedback ?? [];
        const others = existing.filter(f => f.hypothesisId !== feedback.hypothesisId);
        const updated = { ...item, hypothesisFeedback: [...others, feedback] };
        this.items.set(id, updated);
        return updated;
    }
    /**
     * Record or update a per-action verdict for a feed item.
     * If feedback for the same `actionId` already exists it is replaced.
     */
    addActionFeedback(id, feedback) {
        const item = this.items.get(id);
        if (!item) {
            return undefined;
        }
        const existing = item.actionFeedback ?? [];
        const others = existing.filter(f => f.actionId !== feedback.actionId);
        const updated = { ...item, actionFeedback: [...others, feedback] };
        this.items.set(id, updated);
        return updated;
    }
    /** Aggregate feedback statistics across all stored feed items. */
    getStats() {
        const all = [...this.items.values()];
        const total = all.length;
        const withFeedback = all.filter(i => i.feedback !== undefined).length;
        const byVerdict = {
            useful: 0,
            not_useful: 0,
            root_cause_correct: 0,
            root_cause_wrong: 0,
            partially_correct: 0,
        };
        let hypCorrect = 0;
        let hypWrong = 0;
        let actHelpful = 0;
        let actNotHelpful = 0;
        for (const item of all) {
            if (item.feedback) {
                byVerdict[item.feedback]++;
            }
            for (const hf of item.hypothesisFeedback ?? []) {
                if (hf.verdict === 'correct') {
                    hypCorrect++;
                }
                else {
                    hypWrong++;
                }
            }
            for (const af of item.actionFeedback ?? []) {
                if (af.helpful) {
                    actHelpful++;
                }
                else {
                    actNotHelpful++;
                }
            }
        }
        const followedUpCount = all.filter(i => i.followed_up === true).length;
        const proactiveTypes = ['anomaly_detected', 'change_impact'];
        const proactiveItems = all.filter(i => proactiveTypes.includes(i.type));
        const proactiveHitRate = proactiveItems.length > 0
            ? proactiveItems.filter(i => i.followed_up === true).length / proactiveItems.length
            : 0;
        return {
            total,
            withFeedback,
            feedbackRate: total === 0 ? 0 : withFeedback / total,
            byVerdict,
            hypothesisVerdicts: { correct: hypCorrect, wrong: hypWrong },
            actionVerdicts: { helpful: actHelpful, notHelpful: actNotHelpful },
            followedUpCount,
            proactiveHitRate,
        };
    }
    getUnreadCount() {
        let count = 0;
        for (const item of this.items.values()) {
            if (item.status === 'unread') {
                count++;
            }
        }
        return count;
    }
    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }
    notify(item) {
        for (const fn of this.subscribers) {
            fn(item);
        }
    }
}
export const feedStore = new FeedStore();
//# sourceMappingURL=feed-store.js.map
