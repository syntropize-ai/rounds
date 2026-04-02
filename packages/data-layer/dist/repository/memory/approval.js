import { randomUUID } from 'crypto';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export class InMemoryApprovalRepository {
  items = new Map();
  async findById(id) {
    const item = this.items.get(id);
    return item ? this.markExpiredIfNeeded(item) : undefined;
  }
  async findAll(opts) {
    let items = [...this.items.values()].map((i) => this.markExpiredIfNeeded(i));
    if (opts?.offset !== undefined)
      items = items.slice(opts.offset);
    if (opts?.limit !== undefined)
      items = items.slice(0, opts.limit);
    return items;
  }
  async create(data) {
    return this.submit(data);
  }
  async submit(data) {
    const now = new Date().toISOString();
    const record = {
      ...data,
      id: randomUUID(),
      createdAt: now,
    };
    this.items.set(record.id, record);
    return record;
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
  async listPending(tenantId) {
    const results = [];
    for (const item of this.items.values()) {
      const current = this.markExpiredIfNeeded(item);
      if (current.status === 'pending' && (tenantId === undefined || current.tenantId === tenantId)) {
        results.push(current);
      }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async approve(id, by, roles) {
    return this.resolve(id, 'approved', by, roles);
  }
  async reject(id, by, roles) {
    return this.resolve(id, 'rejected', by, roles);
  }
  async override(id, by, roles) {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    const updated = {
      ...item,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.items.set(id, updated);
    return updated;
  }
  async resolve(id, status, by, roles) {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    const current = this.markExpiredIfNeeded(item);
    if (current.status !== 'pending')
      return undefined;
    const updated = {
      ...current,
      status,
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.items.set(id, updated);
    return updated;
  }
  markExpiredIfNeeded(item) {
    if (item.status !== 'pending')
      return item;
    if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) {
      const expired = { ...item, status: 'expired' };
      this.items.set(item.id, expired);
      return expired;
    }
    return item;
  }
  clear() {
    this.items.clear();
  }
}
//# sourceMappingURL=approval.js.map
