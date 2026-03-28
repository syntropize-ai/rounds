import type { CaseRecord, ICaseStore } from './types.js';

export declare class CaseStore implements ICaseStore {
  private readonly records;
  private counter;

  add(record: Omit<CaseRecord, 'id' | 'createdAt'>): CaseRecord;

  get(id: string): CaseRecord | undefined;

  /** @deprecated Use get() — kept for back-compat with partial stubs */
  findById(id: string): CaseRecord | undefined;

  list(): CaseRecord[];

  /** @deprecated Use list() — kept for back-compat with partial stubs */
  getAll(): CaseRecord[];

  update(
    id: string,
    patch: Partial<Omit<CaseRecord, 'id' | 'createdAt'>>
  ): CaseRecord | undefined;

  remove(id: string): boolean;

  clear(): void;

  get size(): number;
}