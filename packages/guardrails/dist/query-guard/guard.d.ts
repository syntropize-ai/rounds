import type { SemanticQuery, DataAdapter } from '@agentic-obs/adapters';
import type { QueryGuardConfig, QueryValidationResult } from './types.js';
export declare class QueryGuard {
    private readonly validator;
    private readonly rateLimiter;
    constructor(config?: QueryGuardConfig);
    /**
     * Check whether a query is allowed for the given session.
     * Records the query against the rate limiter only on success.
     */
    check(query: SemanticQuery, sessionId: string): QueryValidationResult;
    /**
     * Wrap a DataAdapter so every query() call is automatically checked before
     * it reaches the underlying adapter. Other adapter methods are proxied
     * unchanged.
     */
    wrapAdapter(adapter: DataAdapter, sessionId: string): DataAdapter;
}
//# sourceMappingURL=guard.d.ts.map