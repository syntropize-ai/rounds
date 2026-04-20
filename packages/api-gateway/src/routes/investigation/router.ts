// Investigation API router - all /investigations endpoints

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

import { ac, ACTIONS } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { authMiddleware } from '../../middleware/auth.js';
import { createRequirePermission } from '../../middleware/require-permission.js';
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import { investigationOpenApiSpec } from './openapi.js';
import type { SharePermission, IGatewayInvestigationStore, IGatewayFeedStore, IGatewayShareStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import type { CreateInvestigationBody, FollowUpBody, FeedbackBody } from './types.js';
import { initSse, sendSseEvent, sendSseKeepAlive, closeSse } from './sse.js';
import { getOrgId } from '../../middleware/workspace-context.js';

/**
 * Resolve the current request's org id. Prefers `req.auth.orgId` populated by
 * the auth middleware (post-T9 cutover); falls back to the header/query
 * helper for test harnesses that bypass auth.
 */
function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

export interface InvestigationRouterDeps {
  store: IGatewayInvestigationStore;
  feed: IGatewayFeedStore;
  shareRepo: IGatewayShareStore;
  reportStore: IInvestigationReportRepository;
  /**
   * RBAC surface. `AccessControlSurface` is used (not the concrete service)
   * because this router is mounted outside the async auth IIFE in server.ts
   * — the holder forwards to the real service once it's built.
   */
  ac: AccessControlSurface;
}

export function createInvestigationRouter(
  deps: InvestigationRouterDeps,
): Router {
  const store: IGatewayInvestigationStore = deps.store;
  const feed: IGatewayFeedStore = deps.feed;
  const reportStore: IInvestigationReportRepository = deps.reportStore;
  const shareRepo: IGatewayShareStore = deps.shareRepo;

  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // All investigation routes require authentication
  router.use(authMiddleware);

  // -- POST /investigations

  router.post(
    '/',
    requirePermission(() => ac.eval(ACTIONS.InvestigationsCreate)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as CreateInvestigationBody;

        if (!body?.question || typeof body.question !== 'string' || body.question.trim() === '') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'question is required and must be a non-empty string' } });
          return;
        }

        const authReq = req as AuthenticatedRequest;
        const workspaceId = resolveOrgId(req);
        const investigation = await store.create({
          question: body.question.trim(),
          sessionId: body.sessionId ?? `ses_${Date.now()}`,
          userId: authReq.auth?.userId ?? 'anonymous',
          entity: body.entity,
          timeRange: body.timeRange,
          workspaceId,
        });

        // Investigation orchestration now handled by the dashboard agent via chat
        res.status(201).json(investigation);
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/archived
  // Must be registered before /:id to avoid shadowing

  router.get(
    '/archived',
    requirePermission(() => ac.eval(ACTIONS.InvestigationsRead, 'investigations:*')),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await store.getArchived());
      } catch (err) {
        next(err);
      }
    },
  );

  // -- POST /investigations/archived/:id/restore

  router.post(
    '/archived/:id/restore',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsWrite, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const inv = await store.restoreFromArchive(req.params['id'] ?? '');
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Archived investigation not found' } });
          return;
        }
        res.json(inv);
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations

  router.get(
    '/',
    requirePermission(() => ac.eval(ACTIONS.InvestigationsRead, 'investigations:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const workspaceId = resolveOrgId(req);
        const all = (await store.findAll()).filter((inv) => (inv.workspaceId ?? 'default') === workspaceId).map((inv) => ({
          id: inv.id,
          status: inv.status,
          intent: inv.intent,
          sessionId: inv.sessionId,
          userId: inv.userId,
          createdAt: inv.createdAt,
          updatedAt: inv.updatedAt,
        }));
        res.json(all);
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/:id

  router.get(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const inv = await store.findById(req.params['id'] ?? '');
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        const workspaceId = resolveOrgId(req);
        if ((inv.workspaceId ?? 'default') !== workspaceId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        res.json(inv);
      } catch (err) {
        next(err);
      }
    },
  );

  // -- DELETE /investigations/:id

  router.delete(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsDelete, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        const workspaceId = resolveOrgId(req);
        if ((inv.workspaceId ?? 'default') !== workspaceId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        await store.delete(id);
        // Cascade: remove associated investigation reports
        const reports = await reportStore.findByDashboard(id);
        for (const r of reports) {
          await reportStore.delete(r.id);
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/:id/report

  router.get(
    '/:id/report',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        // Reports are stored with investigationId in the dashboardId field
        const reports = await reportStore.findByDashboard(id);
        if (!reports.length) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not yet available' } });
          return;
        }
        res.json(reports[reports.length - 1]);
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/:id/plan

  router.get(
    '/:id/plan',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const inv = await store.findById(req.params['id'] ?? '');
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        res.json({ investigationId: inv.id, plan: inv.plan });
      } catch (err) {
        next(err);
      }
    },
  );

  // -- POST /investigations/:id/follow-up

  router.post(
    '/:id/follow-up',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsWrite, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }

        const body = req.body as FollowUpBody;
        if (!body?.question || typeof body.question !== 'string' || body.question.trim() === '') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'question is required' } });
          return;
        }

        const record = await store.addFollowUp(id, body.question.trim());
        res.status(201).json(record);
      } catch (err) {
        next(err);
      }
    },
  );

  // -- POST /investigations/:id/feedback

  router.post(
    '/:id/feedback',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }

        const body = req.body as FeedbackBody;
        if (typeof body?.helpful !== 'boolean') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'helpful (boolean) is required' } });
          return;
        }

        await store.addFeedback(id, body);
        res.json({ received: true, investigationId: id });
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/:id/conclusion

  router.get(
    '/:id/conclusion',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }

        const conclusion = await store.getConclusion(id);
        if (!conclusion) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conclusion not yet available' } });
          return;
        }

        res.json({ investigationId: id, conclusion });
      } catch (err) {
        next(err);
      }
    },
  );

  // -- POST /investigations/:id/share

  router.post(
    '/:id/share',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsWrite, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }

        const body = req.body as { permission?: SharePermission; expiresInMs?: number } | undefined;
        const link = await shareRepo.create({
          investigationId: id,
          createdBy: authReq.auth?.userId ?? 'unknown',
          permission: body?.permission ?? 'view_only',
          expiresInMs: body?.expiresInMs,
        });

        res.status(201).json({
          token: link.token,
          shareUrl: `/api/shared/${link.token}`,
          permission: link.permission,
          expiresAt: link.expiresAt,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/:id/shares

  router.get(
    '/:id/shares',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }

        const links = await shareRepo.findByInvestigation(id);
        res.json({ shares: links });
      } catch (err) {
        next(err);
      }
    },
  );

  // -- GET /investigations/:id/stream (SSE)

  router.get(
    '/:id/stream',
    requirePermission((req) =>
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? '';
        const inv = await store.findById(id);
        if (!inv) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }

        initSse(res);

        // Emit current state immediately
        sendSseEvent(res, { type: 'investigation:status', data: { id: inv.id, status: inv.status } });

        // If investigation already completed/failed, emit final event and close
        if (inv.status === 'completed' || inv.status === 'failed') {
          sendSseEvent(res, { type: 'investigation:complete', data: inv });
          closeSse(res);
          return;
        }

        // Keep connection alive until client disconnects or investigation completes
        const keepalive = setInterval(() => {
          void Promise.resolve(store.findById(id)).then((latest) => {
            if (!latest) {
              clearInterval(keepalive);
              closeSse(res);
              return;
            }

            sendSseKeepAlive(res);

            if (latest.status === 'completed' || latest.status === 'failed') {
              clearInterval(keepalive);
              sendSseEvent(res, { type: 'investigation:complete', data: latest });
              closeSse(res);
            }
          }).catch(() => {
            clearInterval(keepalive);
            closeSse(res);
          });
        }, 5000);

        req.on('close', () => {
          clearInterval(keepalive);
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}


// OpenAPI spec endpoint (no auth required)
export const openApiRouter = Router();
openApiRouter.get('/', (_req: Request, res: Response) => {
  res.json(investigationOpenApiSpec);
});
