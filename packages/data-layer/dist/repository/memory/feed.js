import { randomUUID } from 'crypto';
export class InMemoryFeedRepository {
    items = new Map();
    async findById(id) {
        return this.items.get(id);
    }
    async findAll(opts = {}) {
        let items = [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (opts.tenantId !== undefined) {
            items = items.filter((i) => i.tenantId === opts.tenantId);
        }
        if (opts.offset !== undefined)
            items = items.slice(opts.offset);
        if (opts.limit !== undefined)
            items = items.slice(0, opts.limit);
        return items;
    }
    async create(data) {
        return this.add(data);
    }
    async add(data) {
        const event = {
            ...data,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
        };
        this.items.set(event.id, event);
        return event;
    }
    async update(id, patch) {
        const existing = this.items.get(id);
        if (!existing)
            return undefined;
        const updated = { ...existing, ...patch, id: existing.id };
        this.items.set(id, updated);
        return updated;
    }
    async delete(id) {
        return this.items.delete(id);
    }
    async count() {
        return this.items.size;
    }
    async findByType(type, tenantId) {
        return [...this.items.values()].filter((i) => i.type === type && (tenantId === undefined || i.tenantId === tenantId));
    }
    async findBySeverity(severity, tenantId) {
        return [...this.items.values()].filter((i) => i.severity === severity && (tenantId === undefined || i.tenantId === tenantId));
    }
    /** Test helper */
    clear() {
        this.items.clear();
    }
}
//# sourceMappingURL=feed.js.map