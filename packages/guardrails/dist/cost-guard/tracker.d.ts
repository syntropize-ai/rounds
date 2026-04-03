import type { CostBudget, CostRecord, CostStatus, BudgetCheckResult } from './types.js';
export declare const DEFAULT_BUDGET: CostBudget;
export declare class CostTracker {
    private readonly records;
    private readonly budget;
    constructor(budget?: CostBudget);
    /** Record LLM token usage for an investigation */
    record(investigationId: string, tokens: {
        prompt: number;
        completion: number;
    }): void;
    /** Record a data-source query for an investigation */
    recordQuery(investigationId: string): void;
    /** Get full cost status for an investigation */
    getStatus(investigationId: string): CostStatus;
    /** Check whether a new LLM call / query is allowed */
    checkBudget(investigationId: string): BudgetCheckResult;
    /** Reset cost records for an investigation */
    reset(investigationId: string): void;
    /** Return aggregate totals across all tracked investigations */
    getTotalCost(): {
        totalTokens: number;
        totalQueries: number;
    };
    /** Return a cost report for all tracked investigations */
    getReport(): CostRecord[];
    private getOrCreate;
    private getSessionTotal;
}
//# sourceMappingURL=tracker.d.ts.map