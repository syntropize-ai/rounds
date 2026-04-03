import { randomUUID } from 'crypto';
export class InMemoryCaseRepository {
    items = new Map();
    async findById(id) {
        return this.items.get(id);
    }
    async findAll(opts = {}) {
        let items = [...this.items.values()];
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
        const caseRecord = {
            ...data,
            id: data.id ?? `case_${randomUUID().slice(0, 8)}`,
            createdAt: new Date().toISOString(),
        };
        this.items.set(caseRecord.id, caseRecord);
        return caseRecord;
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
    async search(query, limit = 10, tenantId) {
        const q = query.toLowerCase();
        const results = [...this.items.values()].filter((c) => {
            if (tenantId !== undefined && c.tenantId !== tenantId)
                return false;
            return (c.title.toLowerCase().includes(q) ||
                c.rootCause.toLowerCase().includes(q) ||
                c.resolution.toLowerCase().includes(q) ||
                c.symptoms.some((s) => s.toLowerCase().includes(q)) ||
                c.tags.some((t) => t.toLowerCase().includes(q)));
        });
        return results.slice(0, limit);
    }
    async findByService(serviceId, tenantId) {
        return [...this.items.values()].filter((c) => c.services.includes(serviceId) &&
            (tenantId === undefined || c.tenantId === tenantId));
    }
    /** Test helper */
    clear() {
        this.items.clear();
    }
}
//# sourceMappingURL=case.js.map