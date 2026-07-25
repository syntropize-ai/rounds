import { Router } from 'express';
import type { Request, Response } from 'express';
import { registry } from '../metrics.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const metricsRouter = Router();

metricsRouter.use((req: Request, res: Response, next) => {
  authMiddleware(req as AuthenticatedRequest, res, next);
});

/**
 * GET /api/metrics
 *
 * Returns all Prometheus metrics in the standard text/plain exposition format.
 * Compatible with Prometheus scrape config, Grafana Agent, and OpenTelemetry Collector.
 */
metricsRouter.get('/', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const metrics = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
}));
