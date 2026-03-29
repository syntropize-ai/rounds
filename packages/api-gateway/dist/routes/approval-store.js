import { randomUUID } from 'crypto';
export const DEFAULT_TTL_MS = 24 * 60 * 1000; // 24 hours
export class ApprovalStore {
    requests = new Map();
    callbacks = new Set();
    submit(params) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS));
        const request = {
            id: randomUUID(),
            action: params.action,
            context: params.context,
            status: 'pending',
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
        };
        this.requests.set(request.id, request);
        return request;
    }
    findById(id) {
        const req = this.requests.get(id);
        if (!req) {
            return undefined;
        }
        return this.markExpiredIfNeeded(req);
    }
    /* Returns only pending, non-expired requests */
    listPending() {
        const results = [];
        for (const req of this.requests.values()) {
            const current = this.markExpiredIfNeeded(req);
            if (current.status === 'pending') {
                results.push(current);
            }
        }
        return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    approve(id, by, roles) {
        return this.resolve(id, 'approved', by, roles);
    }
    reject(id, by, roles) {
        return this.resolve(id, 'rejected', by, roles);
    }
    /* Admin override: force-approve a request regardless of current status
     * (e.g., re-approve a previously rejected request).
     */
    override(id, by, roles) {
        const req = this.requests.get(id);
        if (!req) {
            return undefined;
        }
        const updated = {
            ...req,
            status: 'approved',
            resolvedAt: new Date().toISOString(),
            resolvedBy: by,
            resolvedByRoles: roles,
        };
        this.requests.set(id, updated);
        this.notify(updated);
        return updated;
    }
    /* Register a callback invoked whenever a request is approved or rejected */
    onResolved(callback) {
        this.callbacks.add(callback);
        return () => this.callbacks.delete(callback);
    }
    get size() {
        return this.requests.size;
    }
    // -- Private helpers --
    resolve(id, status, by, roles) {
        const req = this.requests.get(id);
        if (!req) {
            return undefined;
        }
        // Expire first to check if it'll still countable
        const current = this.markExpiredIfNeeded(req);
        if (current.status !== 'pending') {
            return undefined; // already resolved or expired
        }
        const updated = {
            ...current,
            status,
            resolvedAt: new Date().toISOString(),
            resolvedBy: by,
            resolvedByRoles: roles,
        };
        this.requests.set(id, updated);
        this.notify(updated);
        return updated;
    }
    markExpiredIfNeeded(req) {
        if (req.status !== 'pending') {
            return req;
        }
        if (new Date(req.expiresAt) <= new Date()) {
            const expired = { ...req, status: 'expired' };
            this.requests.set(req.id, expired);
            return expired;
        }
        return req;
    }
    notify(request) {
        for (const cb of this.callbacks) {
            cb(request);
        }
    }
}
export const approvalStore = new ApprovalStore();
//# sourceMappingURL=approval-store.js.map
