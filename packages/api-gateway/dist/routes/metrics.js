import { Router } from 'express';
import { registry } from '../metrics.js';
export const metricsRouter = Router();
/**
 * GET /api/metrics
 *
 * Returns all Prometheus metrics in the standard text/plain exposition format.
 * Compatible with Prometheus scrape config, Grafana Agent, and OpenTelemetry Collector.
 */
metricsRouter.get('/', async (_req, res) => {
    try {
        const metrics = await registry.metrics();
        res.set('Content-Type', registry.contentType);
        res.end(metrics);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to collect metrics' });
    }
});
//# sourceMappingURL=metrics.js.map
