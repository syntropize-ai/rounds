import { QueryValidator } from './validator.js';
import { QueryRateLimiter } from './rate-limiter.js';
export class QueryGuard {
    validator;
    rateLimiter;
    constructor(config = {}) {
        this.validator = new QueryValidator(config);
        this.rateLimiter = new QueryRateLimiter(config);
    }
    /**
     * Check whether a query is allowed for the given session.
     * Records the query against the rate limiter only on success.
     */
    check(query, sessionId) {
        const rateCheck = this.rateLimiter.checkRate(sessionId);
        if (!rateCheck.allowed) {
            return { allowed: false, reason: rateCheck.reason, warnings: [] };
        }
        const validation = this.validator.validate(query);
        if (!validation.allowed) {
            return validation;
        }
        this.rateLimiter.record(sessionId);
        return validation;
    }
    /**
     * Wrap a DataAdapter so every query() call is automatically checked before
     * it reaches the underlying adapter. Other adapter methods are proxied
     * unchanged.
     */
    wrapAdapter(adapter, sessionId) {
        const guard = this;
        const wrapped = {
            name: adapter.name,
            description: adapter.description,
            meta: () => adapter.meta(),
            query: async (semanticQuery) => {
                const result = guard.check(semanticQuery, sessionId);
                if (!result.allowed) {
                    throw new Error(`QueryGuard blocked query: ${result.reason}`);
                }
                return adapter.query(semanticQuery);
            },
            healthCheck: () => adapter.healthCheck(),
        };
        if (adapter.stream) {
            wrapped.stream = (sub) => adapter.stream(sub);
        }
        return wrapped;
    }
}
//# sourceMappingURL=guard.js.map