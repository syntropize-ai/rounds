// CaseStore - in-memory CRUD store for CaseRecord (v1)

import type { CaseRecord, ICaseStore } from './types.js';

export class CaseStore implements ICaseStore {
  private readonly records = new Map<string, CaseRecord>();
  private counter = 0;

  add(record: Omit<CaseRecord, 'id' | 'createdAt'>): CaseRecord {
    const id = `case-${++this.counter}`;
    const full: CaseRecord = { ...record, id, createdAt: new Date().toISOString() };
    this.records.set(id, full);
    return full;
  }

  get(id: string): CaseRecord | undefined {
    return this.records.get(id);
  }

  list(): CaseRecord[] {
    return [...this.records.values()];
  }

  update(
    id: string,
    patch: Partial<Omit<CaseRecord, 'id' | 'createdAt'>>,
  ): CaseRecord | undefined {
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const updated: CaseRecord = { ...existing, ...patch };
    this.records.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
