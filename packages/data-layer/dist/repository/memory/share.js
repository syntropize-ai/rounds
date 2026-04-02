import { randomUUID } from 'crypto';
export class InMemoryShareRepository {
  items = new Map();
  async findById(id) {
    for (const link of this.items.values()) {
      if (link.id === id) {
        return this.checkExpiry(link);
      }
    }
    return undefined;
  }
  async findByToken(token) {
    const link = this.items.get(token);
    if (!link)
      return undefined;
    return this.checkExpiry(link);
  }
  async findAll(opts) {
    const now = Date.now();
    let items = [...this.items.values()].filter((l) => !l.expiresAt || new Date(l.expiresAt).getTime() >= now);
    if (opts?.offset !== undefined)
      items = items.slice(opts.offset);
    if (opts?.limit !== undefined)
      items = items.slice(0, opts.limit);
    return items;
  }
  async create(data) {
    const link = {
      ...data,
      id: data.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.items.set(link.token, link);
    return link;
  }
  async update(id, patch) {
    for (const [token, link] of this.items.entries()) {
      if (link.id === id) {
        const updated = { ...link, ...patch, id: link.id };
        this.items.set(token, updated);
        return updated;
      }
    }
    return undefined;
  }
  async delete(id) {
    for (const [token, link] of this.items.entries()) {
      if (link.id === id) {
        this.items.delete(token);
        return true;
      }
    }
    return false;
  }
  async count() {
    return this.items.size;
  }
  async findByInvestigation(investigationId) {
    const now = Date.now();
    return [...this.items.values()].filter((l) => l.investigationId === investigationId && (!l.expiresAt || new Date(l.expiresAt).getTime() >= now));
  }
  async revoke(token) {
    return this.items.delete(token);
  }
  checkExpiry(link) {
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      this.items.delete(link.token);
      return undefined;
    }
    return link;
  }
  clear() {
    this.items.clear();
  }
}
//# sourceMappingURL=share.js.map
