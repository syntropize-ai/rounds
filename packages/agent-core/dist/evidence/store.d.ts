import type { Evidence } from '@agentic-obs/common';

export declare class EvidenceStore {
    private readonly items;
    add(evidence: Evidence): void;
    addAll(items: Evidence[]): void;
    get(id: string): Evidence | undefined;
    getByHypothesis(hypothesisId: string): Evidence[];
    getByIds(ids: string[]): Evidence[];
    list(): Evidence[];
    get size(): number;
    clear(): void;
}
//# sourceMappingURL=store.d.ts.map