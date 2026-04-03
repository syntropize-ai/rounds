// /api/schedules - CRUD endpoints for scheduled investigations

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import type { ScheduledInvestigation } from '@agentic-obs/agent-core';
import type { ScheduleConfig } from '@agentic-obs/agent-core';

export interface ScheduleRouterDeps {
  scheduler: ScheduledInvestigation;
}

export function createScheduleRouter(deps: ScheduleRouterDeps): Router {
  if (!deps.scheduler) {
    throw new Error('createScheduleRouter: scheduler is required. Provide a ScheduledInvestigation instance via deps.scheduler');
  }

  const scheduler = deps.scheduler;
  const router = Router();

  router.use(authMiddleware);

  // POST /api/schedules
  router.post('/', requirePermission('investigation:create'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<ScheduleConfig>;
      if (!body.serviceId || !body.cron || !body.depth || !body.description) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'serviceId, cron, depth, and description are required' });
        return;
      }
      if (!['quick', 'thorough'].includes(body.depth)) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'depth must be "quick" or "thorough"' });
        return;
      }
      const record = scheduler.schedule(body as ScheduleConfig);
      res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/schedules
  router.get('/', requirePermission('investigation:read'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.query['tenantId'] as string | undefined;
      res.json(scheduler.list(tenantId));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/schedules/:id
  router.get('/:id', requirePermission('investigation:read'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = scheduler.get(req.params['id'] ?? '');
      if (!record) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Schedule not found' });
        return;
      }
      res.json(record);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/schedules/:id
  router.delete('/:id', requirePermission('investigation:write'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const removed = scheduler.unschedule(req.params['id'] ?? '');
      if (!removed) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Schedule not found' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
