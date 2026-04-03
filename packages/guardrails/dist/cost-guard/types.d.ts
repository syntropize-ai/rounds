export interface CostBudget {
    /** Max total tokens (prompt + completion) per investigation */
    maxTokensPerInvestigation: number;
    /** Max total tokens per session (across all investigations) */
    maxTokensPerSession: number;
    /** Max data-source queries per investigation */
    maxQueriesPerInvestigation: number;
    /** Percent of budget consumed that triggers a warning (0-100) */
    warningThresholdPercent: number;
}
export interface CostRecord {
    investigationId: string;
    promptTokens: number;
    completionTokens: number;
    /** Total tokens = promptTokens + completionTokens */
    totalTokens: number;
    queryCount: number;
    timestamp: string;
}
export interface CostStatus {
    used: CostRecord;
    budget: CostBudget;
    /** Percentage of maxTokensPerInvestigation used (0-100+) */
    percentUsed: number;
    isOverBudget: boolean;
    isWarning: boolean;
}
export interface BudgetCheckResult {
    allowed: boolean;
    reason?: string;
}
export declare class BudgetExceededError extends Error {
    readonly investigationId: string;
    readonly reason: string;
    constructor(investigationId: string, reason: string);
}
//# sourceMappingURL=types.d.ts.map