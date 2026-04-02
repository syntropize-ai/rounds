import { randomUUID } from 'crypto';
import type { ICaseRepository, CaseFindAllOptions } from '../interfaces.js';
import type { Case } from '../types.js';

export class InMemoryCaseRepository implements ICaseRepository {
  private readonly items = new Map<string, Case>();

  async findById(id: string): Promise<Case | undefined> {
    return this.items.get(id);
  }

  async findAll(opts: CaseFindAllOptions = {}): Promise<Case[]> {
    let items = [...this.items.values()];

    if (opts.tenantId !== undefined) {
      items = items.filter((i) => i.tenantId === opts.tenantId);
    }
    if (opts.offset !== undefined) items = items.slice(opts.offset);
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    return items;
  }

  async create(data: Omit<Case, 'id' | 'createdAt'> & { id?: string }): Promise<Case> {
    const caseRecord: Case = {
      ...data,
      id: data.id ?? `case_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.items.set(caseRecord.id, caseRecord);
    return caseRecord;
  }

  async update(id: string, patch: Partial<Omit<Case, 'id'>>): Promise<Case | undefined> {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated: Case = { ...existing, ...patch, id: existing.id };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  async search(query: string, limit = 10, tenantId?: string): Promise<Case[]> {
    const q = query.toLowerCase();
    const results = [...this.items.values()].filter((c) => {
      if (tenantId !== undefined && c.tenantId !== tenantId) return false;
      return (
        c.title.toLowerCase().includes(q) ||
        c.rootCause.toLowerCase().includes(q) ||
        c.resolution.toLowerCase().includes(q) ||
        c.symptoms.some((s) => s.toLowerCase().includes(q)) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
    return results.slice(0, limit);
  }

  async findByService(serviceId: string, tenantId?: string): Promise<Case[]> {
    return [...this.items.values()].filter(
      (c) =>
        c.services.includes(serviceId) &&
        (tenantId === undefined || c.tenantId === tenantId),
    );
  }

  /** Test helper */
  clear(): void {
    this.items.clear();
  }
}
