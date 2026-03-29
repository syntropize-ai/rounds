import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
export function createScheduleRouter(deps) {
    if (!deps.scheduler) {
        throw new Error('createScheduleRouter: scheduler is required. Provide a ScheduledInvestigation instance via deps.scheduler.');
    }
    const scheduler = deps.scheduler;
    const router = Router();
    router.use(authMiddleware);
    router.post('/', requirePermission('investigation:create'), (req, res, next) => {
        try {
            const body = req.body;
            if (!body.serviceId || !body.cron || !body.depth || !body.description) {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'serviceId, cron, depth, and description are required' });
                return;
            }
            if (!['quick', 'thorough'].includes(body.depth)) {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'depth must be "quick" or "thorough"' });
                return;
            }
            const record = scheduler.schedule({ ...body });
            res.status(201).json(record);
        }
        catch (err) {
            next(err);
        }
    });
    router.get('/', requirePermission('investigation:read'), (req, res, next) => {
        try {
            const tenantId = req.query['tenantId'];
            res.json(scheduler.list(tenantId));
        }
        catch (err) {
            next(err);
        }
    });
    router.get('/:id', requirePermission('investigation:read'), (req, res, next) => {
        try {
            const record = scheduler.get(req.params['id'] ?? '');
            if (!record) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Schedule not found' });
                return;
            }
            res.json(record);
        }
        catch (err) {
            next(err);
        }
    });
    router.delete('/:id', requirePermission('investigation:write'), (req, res, next) => {
        try {
            const removed = scheduler.unschedule(req.params['id'] ?? '');
            if (!removed) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Schedule not found' });
                return;
            }
            res.status(204).end();
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=schedules.js.map
