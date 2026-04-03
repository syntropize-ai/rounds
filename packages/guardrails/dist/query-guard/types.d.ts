export interface QueryGuardConfig {
    /** Maximum allowed query time window in milliseconds. Default: 7 days */
    maxTimeWindowMs?: number;
    /** Maximum estimated label-combination cardinality. Default: 100_000 */
    maxCardinalityEstimate?: number;
    /** Maximum queries per session per minute (sliding window). Default: 60 */
    maxQueriesPerMinute?: number;
    /** Maximum total queries per session lifetime. Default: 200 */
    maxQueriesPerSession?: number;
}
export interface QueryValidationResult {
    allowed: boolean;
    reason?: string;
    warnings: string[];
}
export declare const QUERY_GUARD_DEFAULTS: {
    readonly maxTimeWindowMs: number;
    readonly maxCardinalityEstimate: 100000;
    readonly maxQueriesPerMinute: 60;
    readonly maxQueriesPerSession: 200;
};
//# sourceMappingURL=types.d.ts.map