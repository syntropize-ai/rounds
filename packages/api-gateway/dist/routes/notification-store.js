import { randomUUID } from 'crypto';
import { markDirty } from '../persistence.js';
// -- Helpers --
function matchesLabel(labelValue, operator, matchValue) {
    const v = labelValue ?? '';
    switch (operator) {
        case '=': return v === matchValue;
        case '!=': return v !== matchValue;
        case '=~': return new RegExp(matchValue).test(v);
        case '!~': return !new RegExp(matchValue).test(v);
    }
}
function nodeMatchesLabels(node, labels) {
    return node.matchers.every(m => matchesLabel(labels[m.label], m.operator, m.value));
}
/** Walk the tree depth-first and collect all matching policies
 *  */
function walkTree(node, labels, results) {
    const isRoot = node.isDefault === true;
    const matches = isRoot ? true : nodeMatchesLabels(node, labels);
    if (matches) {
        results.push({ node, matched: true });
        // Walk children regardless - they do not depend on this match
        for (const child of node.children) {
            walkTree(child, labels, results);
        }
    }
}
/** Collect matching contact points via proper Grafana-style routing:
 * Start at root (always matches), recurse into children, stop descending
 * a branch when a node matches and continueMatching is false.
 */
function routeTree(node, labels, collected) {
    const isRoot = node.isDefault === true;
    const matches = isRoot ? true : nodeMatchesLabels(node, labels);
    if (!matches) {
        return false;
    }
    // Check children first (more-specific policies)
    let childMatched = false;
    for (const child of node.children) {
        const hit = routeTree(child, labels, collected);
        if (hit) {
            childMatched = true;
            // if this child does not continue matching we stop after it
            if (!child.continueMatching) {
                break;
            }
        }
    }
    // If no child matched (or this is the root) we add this node's contact point
    if (!childMatched || isRoot) {
        if (node.contactPointId) {
            collected.push({
                contactPointId: node.contactPointId,
                groupBy: node.groupBy,
                muteTimingIds: node.muteTimingIds,
            });
        }
    }
    return true;
}
// -- Time-interval helpers --
function minuteOfDay(_, tz) {
    // Convert "now" to the target timezone and extract hours/minutes
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(new Date());
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
    return hour * 60 + minute;
}
function localDateParts(_, tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
    }).formatToParts(new Date());
    const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
    const weekday = weekdayMap[fmt.find(p => p.type === 'weekday')?.value ?? 'Sun'];
    const day = parseInt(fmt.find(p => p.type === 'day')?.value ?? '1', 10);
    const month = parseInt(fmt.find(p => p.type === 'month')?.value ?? '1', 10);
    const year = parseInt(fmt.find(p => p.type === 'year')?.value ?? '2024', 10);
    return { weekday, day, month, year };
}
function intervalActive(interval, now) {
    const tz = interval.location ?? 'UTC';
    const { weekday, day, month, year } = localDateParts(now, tz);
    if (interval.years?.length && interval.years.length > 0) {
        if (!interval.years.includes(year)) {
            return false;
        }
    }
    if (interval.months?.length && interval.months.length > 0) {
        if (!interval.months.includes(month)) {
            return false;
        }
    }
    if (interval.weekdays?.length && interval.weekdays.length > 0) {
        if (!interval.weekdays.includes(weekday)) {
            return false;
        }
    }
    if (interval.daysOfMonth && interval.daysOfMonth.length > 0) {
        // Support negative indices (from end of month)
        const daysInMonth = new Date(year, month, 0).getDate();
        const normalised = interval.daysOfMonth.map(d => d < 0 ? daysInMonth + d + 1 : d);
        if (!normalised.includes(day)) {
            return false;
        }
    }
    if (interval.timesOfDay && interval.timesOfDay.length > 0) {
        const current = minuteOfDay(now, tz);
        const inRange = interval.timesOfDay.some(r => current >= r.startMinute && current <= r.endMinute);
        if (!inRange) {
            return false;
        }
    }
    return true;
}
// -- Store --
export class NotificationStore {
    contactPoints = new Map();
    policyTree;
    muteTimings = new Map();
    constructor() {
        const now = new Date().toISOString();
        this.policyTree = {
            id: 'root',
            matchers: [],
            contactPointId: '',
            groupBy: ['alertname'],
            groupWaitSec: 30,
            groupIntervalSec: 300,
            repeatIntervalSec: 3600,
            continueMatching: false,
            muteTimingIds: [],
            children: [],
            isDefault: true,
            createdAt: now,
            updatedAt: now,
        };
    }
    // -- Contact Points --
    createContactPoint(data) {
        const now = new Date().toISOString();
        const cp = {
            id: `cp_${randomUUID().slice(0, 12)}`,
            name: data.name,
            integrations: data.integrations,
            createdAt: now,
            updatedAt: now,
        };
        this.contactPoints.set(cp.id, cp);
        markDirty();
        return cp;
    }
    findAllContactPoints() {
        return [...this.contactPoints.values()];
    }
    findContactPointById(id) {
        return this.contactPoints.get(id);
    }
    updateContactPoint(id, patch) {
        const cp = this.contactPoints.get(id);
        if (!cp) {
            return undefined;
        }
        const updated = { ...cp, ...patch, updatedAt: new Date().toISOString() };
        this.contactPoints.set(id, updated);
        markDirty();
        return updated;
    }
    deleteContactPoint(id) {
        const result = this.contactPoints.delete(id);
        if (result) {
            markDirty();
        }
        return result;
    }
    // -- Policy Tree --
    getPolicyTree() {
        return this.policyTree;
    }
    updatePolicyTree(tree) {
        this.policyTree = { ...tree, updatedAt: new Date().toISOString() };
        markDirty();
    }
    addChildPolicy(parentId, policy) {
        const now = new Date().toISOString();
        const newNode = {
            ...policy,
            id: policy.id ?? `${randomUUID().slice(0, 12)}`,
            children: [],
            createdAt: now,
            updatedAt: now,
        };
        const parent = this.findNodeById(this.policyTree, parentId);
        if (!parent) {
            return undefined;
        }
        parent.children.push(newNode);
        this.policyTree = { ...this.policyTree, updatedAt: now };
        markDirty();
        return newNode;
    }
    updatePolicy(id, patch) {
        const node = this.findNodeById(this.policyTree, id);
        if (!node) {
            return undefined;
        }
        const now = new Date().toISOString();
        Object.assign(node, { ...patch, updatedAt: now });
        this.policyTree = { ...this.policyTree, updatedAt: now };
        markDirty();
        return node;
    }
    deletePolicy(id) {
        if (id === 'root') {
            return false;
        }
        const deleted = this.removeNodeById(this.policyTree, id);
        if (deleted) {
            this.policyTree = { ...this.policyTree, updatedAt: new Date().toISOString() };
            markDirty();
        }
        return deleted;
    }
    // -- Mute Timings --
    createMuteTiming(data) {
        const now = new Date().toISOString();
        const mt = {
            id: `mute_${randomUUID().slice(0, 12)}`,
            name: data.name,
            timeIntervals: data.timeIntervals,
            createdAt: now,
            updatedAt: now,
        };
        this.muteTimings.set(mt.id, mt);
        markDirty();
        return mt;
    }
    findAllMuteTimings() {
        return [...this.muteTimings.values()];
    }
    findMuteTimingById(id) {
        return this.muteTimings.get(id);
    }
    updateMuteTiming(id, patch) {
        const mt = this.muteTimings.get(id);
        if (!mt) {
            return undefined;
        }
        const updated = { ...mt, ...patch, updatedAt: new Date().toISOString() };
        this.muteTimings.set(id, updated);
        markDirty();
        return updated;
    }
    deleteMuteTiming(id) {
        const result = this.muteTimings.delete(id);
        if (result) {
            markDirty();
        }
        return result;
    }
    // -- Mute timing evaluation --
    isMuted(muteTimingIds, now = new Date()) {
        for (const id of muteTimingIds) {
            const mt = this.muteTimings.get(id);
            if (!mt) {
                continue;
            }
            for (const interval of mt.timeIntervals) {
                if (intervalActive(interval, now)) {
                    return true;
                }
            }
        }
        return false;
    }
    // -- Alert routing --
    routeAlert(labels) {
        const collected = [];
        routeTree(this.policyTree, labels, collected);
        return collected.map(cp => ({
            contactPointId: cp.contactPointId,
            groupBy: cp.groupBy,
            isMuted: this.isMuted(cp.muteTimingIds),
        }));
    }
    // -- Persistable --
    toJSON() {
        return {
            contactPoints: [...this.contactPoints.values()],
            policyTree: this.policyTree,
            muteTimings: [...this.muteTimings.values()],
        };
    }
    loadJSON(data) {
        const d = data;
        if (Array.isArray(d['contactPoints'])) {
            for (const cp of d['contactPoints']) {
                if (cp.id) {
                    this.contactPoints.set(cp.id, cp);
                }
            }
        }
        if (d['policyTree'] && typeof d['policyTree'] === 'object') {
            this.policyTree = d['policyTree'];
        }
        if (Array.isArray(d['muteTimings'])) {
            for (const mt of d['muteTimings']) {
                if (mt.id) {
                    this.muteTimings.set(mt.id, mt);
                }
            }
        }
    }
    // -- Private tree helpers --
    findNodeById(node, id) {
        if (node.id === id) {
            return node;
        }
        for (const child of node.children) {
            const found = this.findNodeById(child, id);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    removeNodeById(node, id) {
        const idx = node.children.findIndex(c => c.id === id);
        if (idx !== -1) {
            node.children.splice(idx, 1);
            return true;
        }
        for (const child of node.children) {
            if (this.removeNodeById(child, id)) {
                return true;
            }
        }
        return false;
    }
}
export const defaultNotificationStore = new NotificationStore();
//# sourceMappingURL=notification-store.js.map
