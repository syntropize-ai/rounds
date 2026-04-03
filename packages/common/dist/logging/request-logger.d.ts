/**
 * Express middleware for structured HTTP request logging with correlation IDs.
 *
 * - Generates a unique requestId (UUID v4) per request
 * - Stores it in AsyncLocalStorage so all loggers in the call chain pick it up
 * - Logs request start (info) and response finish (info with status + duration)
 * - Attaches requestId to res.locals for downstream use
 *
 * Usage:
 *   app.use(requestLogger);
 */
import type { Request, Response, NextFunction } from 'express';
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=request-logger.d.ts.map