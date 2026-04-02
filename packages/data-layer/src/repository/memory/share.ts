import { randomUUID } from 'crypto';
import type { IShareRepository, FindAllOptions } from '../interfaces.js';
import type { ShareLink } from '../types.js';

export class InMemoryShareRepository implements IShareRepository {
  private readonly items = new Map<string, ShareLink>();

  async findById(id: string): Promise<ShareLink | undefined> {
    for (const link of this.items.values()) {
      if (link.id === id) return this.checkExpiry(link);
    }
    return undefined;
  }

  async findByToken(token: string): Promise<ShareLink | undefined> {
    const link = this.items.get(token);
    if (!link) return undefined;
    return this.checkExpiry(link);
  }

  async findAll(opts: FindAllOptions<ShareLink> = {}): Promise<ShareLink[]> {
    const now = Date.now();
    let items = [...this.items.values()].filter(
      (l) => !l.expiresAt || new Date(l.expiresAt).getTime() >= now,
    );

    if (opts.offset !== undefined) items = items.slice(opts.offset);
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    return items;
  }

  async create(data: Omit<ShareLink, 'id' | 'createdAt'> & { id?: string }): Promise<ShareLink> {
    const link: ShareLink = {
      ...data,
      id: data.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.items.set(link.token, link);
    return link;
  }

  async update(id: string, patch: Partial<Omit<ShareLink, 'id'>>): Promise<ShareLink | undefined> {
    for (const [token, link] of this.items.entries()) {
      if (link.id === id) {
        const updated: ShareLink = { ...link, ...patch, id: link.id };
        this.items.set(token, updated);
        return updated;
      }
    }
    return undefined;
  }

  async delete(id: string): Promise<boolean> {
    for (const [token, link] of this.items.entries()) {
      if (link.id === id) {
        this.items.delete(token);
        return true;
      }
    }
    return false;
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  async findByInvestigation(investigationId: string): Promise<ShareLink[]> {
    const now = Date.now();
    return [...this.items.values()].filter(
      (l) =>
        l.investigationId === investigationId &&
        (!l.expiresAt || new Date(l.expiresAt).getTime() >= now),
    );
  }

  async revoke(token: string): Promise<boolean> {
    return this.items.delete(token);
  }

  private checkExpiry(link: ShareLink): ShareLink | undefined {
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      this.items.delete(link.token);
      return undefined;
    }
    return link;
  }

  clear(): void {
    this.items.clear();
  }
}
