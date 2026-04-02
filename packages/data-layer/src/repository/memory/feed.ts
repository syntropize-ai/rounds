import { randomUUID } from 'crypto';
import type { IFeedRepository, FeedFindAllOptions } from '../interfaces.js';
import type { FeedEvent } from '../types.js';

export class InMemoryFeedRepository implements IFeedRepository {
  private readonly items = new Map<string, FeedEvent>();

  async findById(id: string): Promise<FeedEvent | undefined> {
    return this.items.get(id);
  }

  async findAll(opts: FeedFindAllOptions = {}): Promise<FeedEvent[]> {
    let items = [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (opts.tenantId !== undefined) {
      items = items.filter((i) => i.tenantId === opts.tenantId);
    }
    if (opts.offset !== undefined) items = items.slice(opts.offset);
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    return items;
  }

  async create(data: Omit<FeedEvent, 'id' | 'createdAt'> & { id?: string }): Promise<FeedEvent> {
    return this.add(data);
  }

  async add(data: Omit<FeedEvent, 'id' | 'createdAt'>): Promise<FeedEvent> {
    const event: FeedEvent = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.items.set(event.id, event);
    return event;
  }

  async update(id: string, patch: Partial<Omit<FeedEvent, 'id'>>): Promise<FeedEvent | undefined> {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated: FeedEvent = { ...existing, ...patch, id: existing.id };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  async findByType(type: string, tenantId?: string): Promise<FeedEvent[]> {
    return [...this.items.values()].filter(
      (i) => i.type === type && (tenantId === undefined || i.tenantId === tenantId),
    );
  }

  async findBySeverity(severity: string, tenantId?: string): Promise<FeedEvent[]> {
    return [...this.items.values()].filter(
      (i) => i.severity === severity && (tenantId === undefined || i.tenantId === tenantId),
    );
  }

  /** Test helper */
  clear(): void {
    this.items.clear();
  }
}
