// Investigation API router - all /investigations endpoints

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';

import { ac, ACTIONS } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { authMiddleware } from '../../middleware/auth.js';
import { createRequirePermission } from '../../middleware/require-permission.js';
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';
import { InvestigationStreamService } from '../../services/investigation-stream-service.js';
import { InvestigationWorkspaceService } from '../../services/investigation-workspace-service.js';
import { investigationOpenApiSpec } from './openapi.js';
import type { SharePermission, IGatewayInvestigationStore, IGatewayFeedStore, IGatewayShareStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import type { CreateInvestigationBody, FollowUpBody, FeedbackBody } from './types.js';
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
  const reportStore: IInvestigationReportRepository = deps.reportStore;
  const shareRepo: IGatewayShareStore = deps.shareRepo;
  const workspaceService = new InvestigationWorkspaceService(store, reportStore);
  const streamService = new InvestigationStreamService(store);

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
          sessionId: `inv_${Date.now()}`,
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
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const workspaceId = resolveOrgId(req);
        res.json(await workspaceService.listArchived(workspaceId));
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
        const workspaceId = resolveOrgId(req);
        const inv = await workspaceService.restoreArchived(req.params['id'] ?? '', workspaceId);
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
        res.json(await workspaceService.listSummaries(workspaceId));
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
        const workspaceId = resolveOrgId(req);
        const inv = await workspaceService.findByIdInWorkspace(req.params['id'] ?? '', workspaceId);
        if (!inv) {
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
        const workspaceId = resolveOrgId(req);
        const deleted = await workspaceService.deleteWithReports(id, workspaceId);
        if (!deleted) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
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
        const workspaceId = resolveOrgId(req);
        const report = await workspaceService.getLatestReport(id, workspaceId);
        if (report.status === 'investigation_missing') {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        if (report.status === 'not_found') {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not yet available' } });
          return;
        }
        res.json(report.report);
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
        const workspaceId = resolveOrgId(req);
        const plan = await workspaceService.getPlan(req.params['id'] ?? '', workspaceId);
        if (!plan) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        res.json(plan);
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
        const body = req.body as FollowUpBody;
        if (!body?.question || typeof body.question !== 'string' || body.question.trim() === '') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'question is required' } });
          return;
        }

        const workspaceId = resolveOrgId(req);
        const record = await workspaceService.addFollowUp(id, workspaceId, body.question.trim());
        if (!record) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
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
        const body = req.body as FeedbackBody;
        if (typeof body?.helpful !== 'boolean') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'helpful (boolean) is required' } });
          return;
        }

        const workspaceId = resolveOrgId(req);
        const added = await workspaceService.addFeedback(id, workspaceId, body);
        if (!added) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
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
        const workspaceId = resolveOrgId(req);
        const conclusion = await workspaceService.getConclusion(id, workspaceId);
        if (conclusion.status === 'investigation_missing') {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
        if (conclusion.status === 'not_found') {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conclusion not yet available' } });
          return;
        }

        res.json({ investigationId: id, conclusion: conclusion.conclusion });
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
        const workspaceId = resolveOrgId(req);
        const inv = await workspaceService.findByIdInWorkspace(id, workspaceId);
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
        const workspaceId = resolveOrgId(req);
        const inv = await workspaceService.findByIdInWorkspace(id, workspaceId);
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
        const workspaceId = resolveOrgId(req);
        const streaming = await streamService.stream(id, workspaceId, req, res);
        if (!streaming) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
          return;
        }
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
