import type { CaseRecord, ICaseStore } from './types.js';
export declare class CaseStore implements ICaseStore {
    private readonly records;
    private counter;
    add(record: Omit<CaseRecord, 'id' | 'createdAt'>): CaseRecord;
    get(id: string): CaseRecord | undefined;
    list(): CaseRecord[];
    update(id: string, patch: Partial<Omit<CaseRecord, 'id' | 'createdAt'>>): CaseRecord | undefined;
    remove(id: string): boolean;
    clear(): void;
    get size(): number;
}
//# sourceMappingURL=case-store.d.ts.map