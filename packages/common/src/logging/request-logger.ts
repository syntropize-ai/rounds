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
import { v4 as uuidv4 } from 'uuid';
import { correlationStore } from './correlation.js';
import { createLogger } from './logger.js';

const httpLogger = createLogger('http');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();

  // Make requestId accessible to route handlers via res.locals
  res.locals['requestId'] = requestId;

  const start = Date.now();

  correlationStore.run({ requestId }, () => {
    // `mixin` on httpLogger will automatically inject requestId from correlationStore
    httpLogger.info({ method: req.method, url: req.url }, 'request received');

    res.on('finish', () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      httpLogger[level](
        { method: req.method, url: req.url, status: res.statusCode, duration },
        'request completed',
      );
    });

    next();
  });
}
