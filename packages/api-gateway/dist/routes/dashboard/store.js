// In-memory store for dashboards
import { markDirty } from '../../persistence.js';
function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export class DashboardStore {
    dashboards = new Map();
    maxCapacity;
    constructor(maxCapacity = 500) {
        this.maxCapacity = maxCapacity;
    }
    create(params) {
        const now = new Date().toISOString();
        const id = uid();
        const dashboard = {
            id,
            type: 'dashboard',
            title: params.title,
            description: params.description,
            prompt: params.prompt,
            userId: params.userId,
            status: 'generating',
            panels: [],
            variables: [],
            refreshIntervalSec: 30,
            datasourceIds: params.datasourceIds,
            useExistingMetrics: params.useExistingMetrics ?? true,
            ...(params.folder !== undefined ? { folder: params.folder } : {}),
            createdAt: now,
            updatedAt: now,
        };
        this.dashboards.set(id, dashboard);
        this.evictIfNeeded();
        markDirty();
        return dashboard;
    }
    evictIfNeeded() {
        if (this.dashboards.size <= this.maxCapacity)
            return;
        let oldest;
        for (const d of this.dashboards.values()) {
            if ((d.status === 'ready' || d.status === 'failed')) {
                if (!oldest || d.createdAt < oldest.createdAt) {
                    oldest = d;
                }
            }
        }
        if (oldest) {
            this.dashboards.delete(oldest.id);
        }
    }
    findById(id) {
        return this.dashboards.get(id);
    }
    findAll(userId) {
        const all = [...this.dashboards.values()];
        if (userId === undefined)
            return all;
        return all.filter((d) => d.userId === userId);
    }
    update(id, patch) {
        const d = this.dashboards.get(id);
        if (!d)
            return undefined;
        const updated = { ...d, ...patch, updatedAt: new Date().toISOString() };
        this.dashboards.set(id, updated);
        markDirty();
        return updated;
    }
    updateStatus(id, status, error) {
        const d = this.dashboards.get(id);
        if (!d)
            return undefined;
        const updated = { ...d, status, updatedAt: new Date().toISOString() };
        if (error !== undefined)
            updated.error = error;
        this.dashboards.set(id, updated);
        markDirty();
        return updated;
    }
    updatePanels(id, panels) {
        const d = this.dashboards.get(id);
        if (!d)
            return undefined;
        const updated = { ...d, panels, updatedAt: new Date().toISOString() };
        this.dashboards.set(id, updated);
        markDirty();
        return updated;
    }
    updateVariables(id, variables) {
        const d = this.dashboards.get(id);
        if (!d)
            return undefined;
        const updated = { ...d, variables, updatedAt: new Date().toISOString() };
        this.dashboards.set(id, updated);
        markDirty();
        return updated;
    }
    delete(id) {
        const result = this.dashboards.delete(id);
        if (result)
            markDirty();
        return result;
    }
    get size() {
        return this.dashboards.size;
    }
    clear() {
        this.dashboards.clear();
    }
    toJSON() {
        return [...this.dashboards.values()];
    }
    loadJSON(data) {
        if (!Array.isArray(data))
            return;
        for (const d of data) {
            if (d.id)
                this.dashboards.set(d.id, d);
        }
    }
}
/** Module-level singleton - replace with DI in production */
export const defaultDashboardStore = new DashboardStore();
//# sourceMappingURL=store.js.map