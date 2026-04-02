import { randomUUID } from 'crypto';
import type { IApprovalRepository, FindAllOptions } from '../interfaces.js';
import type { ApprovalRecord, ApprovalStatus } from '../types.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryApprovalRepository implements IApprovalRepository {
  private readonly items = new Map<string, ApprovalRecord>();

  async findById(id: string): Promise<ApprovalRecord | undefined> {
    const item = this.items.get(id);
    return item ? this.markExpiredIfNeeded(item) : undefined;
  }

  async findAll(opts: FindAllOptions<ApprovalRecord> = {}): Promise<ApprovalRecord[]> {
    let items = [...this.items.values()].map((i) => this.markExpiredIfNeeded(i));
    if (opts.offset !== undefined) items = items.slice(opts.offset);
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    return items;
  }

  async create(
    data: Omit<ApprovalRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ApprovalRecord> {
    return this.submit(data);
  }

  async submit(data: Omit<ApprovalRecord, 'id' | 'createdAt'>): Promise<ApprovalRecord> {
    const now = new Date().toISOString();
    const record: ApprovalRecord = {
      ...data,
      id: randomUUID(),
      createdAt: now,
    };
    this.items.set(record.id, record);
    return record;
  }

  async update(
    id: string,
    patch: Partial<Omit<ApprovalRecord, 'id'>>,
  ): Promise<ApprovalRecord | undefined> {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated: ApprovalRecord = { ...existing, ...patch, id: existing.id };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  async listPending(tenantId?: string): Promise<ApprovalRecord[]> {
    const results: ApprovalRecord[] = [];
    for (const item of this.items.values()) {
      const current = this.markExpiredIfNeeded(item);
      if (current.status === 'pending' && (tenantId === undefined || current.tenantId === tenantId)) {
        results.push(current);
      }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async approve(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined> {
    return this.resolve(id, 'approved', by, roles);
  }

  async reject(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined> {
    return this.resolve(id, 'rejected', by, roles);
  }

  async override(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined> {
    const item = this.items.get(id);
    if (!item) return undefined;
    const updated: ApprovalRecord = {
      ...item,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.items.set(id, updated);
    return updated;
  }

  private resolve(
    id: string,
    status: 'approved' | 'rejected',
    by: string,
    roles?: string[],
  ): ApprovalRecord | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    const current = this.markExpiredIfNeeded(item);
    if (current.status !== 'pending') return undefined;

    const updated: ApprovalRecord = {
      ...current,
      status,
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.items.set(id, updated);
    return updated;
  }

  private markExpiredIfNeeded(item: ApprovalRecord): ApprovalRecord {
    if (item.status !== 'pending') return item;
    if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) {
      const expired: ApprovalRecord = { ...item, status: 'expired' as ApprovalStatus };
      this.items.set(item.id, expired);
      return expired;
    }
    return item;
  }

  clear(): void {
    this.items.clear();
  }
}
