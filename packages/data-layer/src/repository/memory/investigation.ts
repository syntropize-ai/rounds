import { randomUUID } from 'crypto';
import type { Investigation } from '@agentic-obs/common';
import type {
  IInvestigationRepository,
  InvestigationFindAllOptions,
} from '../interfaces.js';

export class InMemoryInvestigationRepository implements IInvestigationRepository {
  private readonly active = new Map<string, Investigation>();
  private readonly archived = new Map<string, Investigation>();

  async findById(id: string): Promise<Investigation | undefined> {
    return this.active.get(id) ?? this.archived.get(id);
  }

  async findAll(opts: InvestigationFindAllOptions = {}): Promise<Investigation[]> {
    let items = [...this.active.values()];

    if (opts.tenantId !== undefined) {
      items = items.filter((i) => (i as Investigation & { tenantId?: string }).tenantId === opts.tenantId);
    }
    if (opts.status !== undefined) {
      items = items.filter((i) => i.status === opts.status);
    }
    if (opts.offset !== undefined) items = items.slice(opts.offset);
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    return items;
  }

  async create(
    data: Omit<Investigation, 'id' | 'createdAt'> & { id?: string },
  ): Promise<Investigation> {
    const now = new Date().toISOString();
    const investigation: Investigation = {
      ...data,
      id: data.id ?? `inv_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: data.updatedAt ?? now,
    } as Investigation;
    this.active.set(investigation.id, investigation);
    return investigation;
  }

  async update(
    id: string,
    patch: Partial<Omit<Investigation, 'id'>>,
  ): Promise<Investigation | undefined> {
    const existing = this.active.get(id);
    if (!existing) return undefined;
    const updated: Investigation = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    } as Investigation;
    this.active.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.active.delete(id) || this.archived.delete(id);
  }

  async count(): Promise<number> {
    return this.active.size;
  }

  async findBySession(sessionId: string): Promise<Investigation[]> {
    return [...this.active.values()].filter((i) => i.sessionId === sessionId);
  }

  async findByUser(userId: string, _tenantId?: string): Promise<Investigation[]> {
    return [...this.active.values()].filter((i) => i.userId === userId);
  }

  async archive(id: string): Promise<Investigation | undefined> {
    const item = this.active.get(id);
    if (!item) return undefined;
    this.active.delete(id);
    const archived: Investigation = { ...item, updatedAt: new Date().toISOString() } as Investigation;
    this.archived.set(id, archived);
    return archived;
  }

  async restore(id: string): Promise<Investigation | undefined> {
    const item = this.archived.get(id);
    if (!item) return undefined;
    this.archived.delete(id);
    const restored: Investigation = { ...item, updatedAt: new Date().toISOString() } as Investigation;
    this.active.set(id, restored);
    return restored;
  }

  async findArchived(_tenantId?: string): Promise<Investigation[]> {
    return [...this.archived.values()];
  }

  /** Test helper */
  clear(): void {
    this.active.clear();
    this.archived.clear();
  }
}
