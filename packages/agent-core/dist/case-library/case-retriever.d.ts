import type { CaseQuery, CaseRetriever, ScoredCase } from './types.js';
import type { ICaseStore } from './types.js';
export declare class KeywordCaseRetriever implements CaseRetriever {
    private readonly store;
    constructor(store: ICaseStore);
    search(query: CaseQuery): ScoredCase[];
    static jaccardTokens(a: string, b: string): number;
    static jaccardStringArrays(a: string[], b: string[]): number;
}
//# sourceMappingURL=case-retriever.d.ts.map