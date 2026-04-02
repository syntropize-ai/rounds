import { randomUUID } from 'crypto';
export class InMemoryIncidentRepository {
  active = new Map();
  archived = new Map();
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
    if (opts.offset !== undefined) {
      items = items.slice(opts.offset);
    }
    if (opts.limit !== undefined) {
      items = items.slice(0, opts.limit);
    }
    return items;
  }
  async create(data) {
    const now = new Date().toISOString();
    const incident = {
      ...data,
      id: data.id ?? `inc_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: data.updatedAt ?? now,
    };
    this.active.set(incident.id, incident);
    return incident;
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
  async addTimelineEntry(incidentId, entry) {
    const incident = this.active.get(incidentId);
    if (!incident)
      return undefined;
    const newEntry = {
      ...entry,
      id: `tle_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
    };
    const updated = {
      ...incident,
      timeline: [...incident.timeline, newEntry],
      updatedAt: new Date().toISOString(),
    };
    this.active.set(incidentId, updated);
    return newEntry;
  }
  async findByService(serviceId, _tenantId) {
    return [...this.active.values()].filter((i) => i.services.includes(serviceId));
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
  /** Test helper */
  clear() {
    this.active.clear();
    this.archived.clear();
  }
}
//# sourceMappingURL=incident.js.map
