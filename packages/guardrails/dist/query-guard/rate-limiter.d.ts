import type { QueryGuardConfig } from './types.js';
export declare class QueryRateLimiter {
    private readonly sessions;
    private readonly maxPerMinute;
    private readonly maxPerSession;
    constructor(config?: QueryGuardConfig);
    checkRate(sessionId: string): {
        allowed: boolean;
        reason?: string;
    };
    record(sessionId: string): void;
    private getOrCreate;
}
//# sourceMappingURL=rate-limiter.d.ts.map