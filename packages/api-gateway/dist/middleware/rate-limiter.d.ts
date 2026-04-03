import type { Request, Response, NextFunction } from 'express';
interface RateLimiterOptions {
    windowMs: number;
    max: number;
    keyFn?: (req: Request) => string;
}
export declare function createRateLimiter(options: RateLimiterOptions): (req: Request, res: Response, next: NextFunction) => void;
export declare const defaultRateLimiter: (req: Request, res: Response, next: NextFunction) => void;
export {};
//# sourceMappingURL=rate-limiter.d.ts.map