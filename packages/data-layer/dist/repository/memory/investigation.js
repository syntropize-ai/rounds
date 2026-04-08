import { randomUUID } from 'crypto';
export class InMemoryInvestigationRepository {
    active = new Map();
    archived = new Map();
    followUps = new Map();
    feedbackMap = new Map();
    conclusions = new Map();
    workspaceMap = new Map();
    async findById(id) {
        return this.active.get(id) ?? this.archived.get(id);
    }
    async findAll(opts = {}) {
        let items = [...this.active.values()];
        if (opts.tenantId !== undefined) {
            items = items.filter((i) => i.tenantId === opts.tenantId);
        }
        if (opts.status !== undefined) {
            items = items.filter((i) => i.status === opts.status);
        }
        if (opts.offset !== undefined)
            items = items.slice(opts.offset);
        if (opts.limit !== undefined)
            items = items.slice(0, opts.limit);
        return items;
    }
    async create(data) {
        const now = new Date().toISOString();
        const investigation = {
            ...data,
            id: data.id ?? `inv_${randomUUID().slice(0, 8)}`,
            createdAt: now,
            updatedAt: data.updatedAt ?? now,
        };
        this.active.set(investigation.id, investigation);
        return investigation;
    }
    async update(id, patch) {
        const existing = this.active.get(id);
        if (!existing)
            return undefined;
        const updated = {
            ...existing,
            ...patch,
            id: existing.id,
            updatedAt: new Date().toISOString(),
        };
        this.active.set(id, updated);
        return updated;
    }
    async delete(id) {
        return this.active.delete(id) || this.archived.delete(id);
    }
    async count() {
        return this.active.size;
    }
    async findBySession(sessionId) {
        return [...this.active.values()].filter((i) => i.sessionId === sessionId);
    }
    async findByUser(userId, _tenantId) {
        return [...this.active.values()].filter((i) => i.userId === userId);
    }
    async archive(id) {
        const item = this.active.get(id);
        if (!item)
            return undefined;
        this.active.delete(id);
        const archived = { ...item, updatedAt: new Date().toISOString() };
        this.archived.set(id, archived);
        return archived;
    }
    async restore(id) {
        const item = this.archived.get(id);
        if (!item)
            return undefined;
        this.archived.delete(id);
        const restored = { ...item, updatedAt: new Date().toISOString() };
        this.active.set(id, restored);
        return restored;
    }
    async findArchived(_tenantId) {
        return [...this.archived.values()];
    }
    async findByWorkspace(workspaceId) {
        return [...this.active.values()].filter((inv) => this.workspaceMap.get(inv.id) === workspaceId);
    }
    async addFollowUp(investigationId, question) {
        const record = {
            id: `fu_${randomUUID().slice(0, 8)}`,
            investigationId,
            question,
            createdAt: new Date().toISOString(),
        };
        const existing = this.followUps.get(investigationId) ?? [];
        existing.push(record);
        this.followUps.set(investigationId, existing);
        return record;
    }
    async getFollowUps(investigationId) {
        return this.followUps.get(investigationId) ?? [];
    }
    async addFeedback(investigationId, body) {
        const record = {
            id: `fb_${randomUUID().slice(0, 8)}`,
            investigationId,
            ...body,
            createdAt: new Date().toISOString(),
        };
        const existing = this.feedbackMap.get(investigationId) ?? [];
        existing.push(record);
        this.feedbackMap.set(investigationId, existing);
        return record;
    }
    async getConclusion(id) {
        return this.conclusions.get(id);
    }
    async setConclusion(id, conclusion) {
        this.conclusions.set(id, conclusion);
    }
    async updateStatus(id, status) {
        return this.update(id, { status });
    }
    async updatePlan(id, plan) {
        return this.update(id, { plan });
    }
    async updateResult(id, result) {
        const updated = await this.update(id, {
            hypotheses: result.hypotheses,
            evidence: result.evidence,
        });
        if (updated && result.conclusion) {
            this.conclusions.set(id, result.conclusion);
        }
        return updated;
    }
    /** Test helper */
    clear() {
        this.active.clear();
        this.archived.clear();
        this.followUps.clear();
        this.feedbackMap.clear();
        this.conclusions.clear();
        this.workspaceMap.clear();
    }
}
//# sourceMappingURL=investigation.js.map