// Investigation API router - all /investigations endpoints
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { investigationOpenApiSpec } from './openapi.js';
import { defaultInvestigationStore } from './store.js';
import { initSse, sendSseEvent, sendSseKeepalive, closeSse } from './sse.js';
import { feedStore as defaultFeedStore } from '../feed-store.js';
import { LiveOrchestratorRunner } from './live-orchestrator-runner.js';
import { defaultShareStore } from './share-store.js';

export function createInvestigationRouter(deps = {}) {
  const store = deps.store ?? defaultInvestigationStore;
  const feed = deps.feed ?? defaultFeedStore;
  const orchestrator = deps.orchestrator ?? new LiveOrchestratorRunner(store, feed);
  const shareRepo = deps.shareRepo ?? defaultShareStore;
  const router = Router();

  // All investigations routes require authentication
  router.use(authMiddleware);

  // POST /investigations
  router.post('/', requirePermission('investigation:create'), async (req, res, next) => {
    try {
      const auth = req.auth;
      const body = req.body;
      if (!body?.question || typeof body.question !== 'string' || !body.question.trim()) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'question is required and must be a non-empty string' });
        return;
      }
      const investigation = await store.create({
        question: body.question.trim(),
        sessionId: auth?.sub ?? randomUUID(),
        userId: auth?.sub ?? 'anonymous',
        entity: body.entity,
        timeRange: body.timeRange,
      });
      // Async orchestration - does not block the HTTP response
      orchestrator.run({
        investigationId: investigation.id,
        sessionId: investigation.sessionId,
        question: investigation.intent,
        userId: investigation.userId,
      });
      res.status(201).json(investigation);
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations/archived
  // Must be registered before /:id to avoid shadowing
  router.get('/archived', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      res.json(await store.getArchived());
    }
    catch (err) {
      next(err);
    }
  });

  // POST /investigations/archived/:id/restore
  router.post('/archived/:id/restore', requirePermission('investigation:write'), async (req, res, next) => {
    try {
      const inv = await store.restoreFromArchive(req.params['id'] ?? '');
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Archived investigation not found' });
        return;
      }
      res.json(inv);
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations
  router.get('/', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const all = (await store.findAll()).map((inv) => ({
        id: inv.id,
        status: inv.status,
        question: inv.intent,
        sessionId: inv.sessionId,
        userId: inv.userId,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      }));
      res.json(all);
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations/:id
  router.get('/:id', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const inv = await store.findById(req.params['id'] ?? '');
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      res.json(inv);
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations/:id/plan
  router.get('/:id/plan', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const inv = await store.findById(req.params['id'] ?? '');
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      res.json({ investigationId: inv.id, plan: inv.plan });
    }
    catch (err) {
      next(err);
    }
  });

  // POST /investigations/:id/follow-up
  router.post('/:id/followup', requirePermission('investigation:create'), async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const inv = await store.findById(id);
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      const body = req.body;
      if (!body?.question || typeof body.question !== 'string' || !body.question.trim()) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'question is required' });
        return;
      }
      const record = await store.addFollowUp(id, body.question.trim());
      res.status(201).json(record);
    }
    catch (err) {
      next(err);
    }
  });

  // POST /investigations/:id/feedback
  router.post('/:id/feedback', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const inv = await store.findById(id);
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      const body = req.body;
      if (typeof body?.helpful !== 'boolean') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'helpful (boolean) is required' });
        return;
      }
      await store.addFeedback(id, body);
      res.json({ received: true, investigationId: id });
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations/:id/conclusion
  router.get('/:id/conclusion', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const inv = await store.findById(id);
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      const conclusion = await store.getConclusion(id);
      if (!conclusion) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Conclusion not yet available' });
        return;
      }
      res.json({ investigationId: id, conclusion });
    }
    catch (err) {
      next(err);
    }
  });

  // POST /investigations/:id/share
  router.post('/:id/share', requirePermission('investigation:share'), async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const inv = await store.findById(id);
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      const body = req.body;
      const link = await shareRepo.create({
        token: randomUUID(),
        investigationId: id,
        createdBy: req.auth?.sub ?? 'unknown',
        permission: body?.permission ?? 'view_only',
        expiresAt: body?.expiresInMs
          ? new Date(Date.now() + body.expiresInMs).toISOString()
          : undefined,
      });
      res.status(201).json({
        token: link.token,
        shareUrl: `/api/shares/${link.token}`,
        permission: link.permission,
        expiresAt: link.expiresAt,
      });
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations/:id/shares
  router.get('/:id/shares', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const inv = await store.findById(id);
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      const links = await shareRepo.findByInvestigation(id);
      res.json({ shares: links });
    }
    catch (err) {
      next(err);
    }
  });

  // GET /investigations/:id/stream (SSE)
  router.get('/:id/stream', requirePermission('investigation:read'), async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const inv = await store.findById(id);
      if (!inv) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
        return;
      }
      initSse(res);
      // Emit current state immediately
      sendSseEvent(res, { type: 'investigationstatus', data: { id: inv.id, status: inv.status } });
      // For investigations already completed/failed, emit final event and close
      if (inv.status === 'completed' || inv.status === 'failed') {
        sendSseEvent(res, { type: 'investigationcomplete', data: inv });
        closeSse(res);
        return;
      }
      // Keep connection alive until client disconnects or investigation completes
      const keepAlive = setInterval(() => {
        Promise.resolve(store.findById(id)).then((latest) => {
          if (!latest) {
            clearInterval(keepAlive);
            closeSse(res);
            return;
          }
          sendSseKeepalive(res);
          if (latest.status === 'completed' || latest.status === 'failed') {
            clearInterval(keepAlive);
            sendSseEvent(res, { type: 'investigationcomplete', data: latest });
            closeSse(res);
          }
        }).catch(() => {
          clearInterval(keepAlive);
          closeSse(res);
        });
      }, 5000);
      req.on('close', () => {
        clearInterval(keepAlive);
      });
    }
    catch (err) {
      next(err);
    }
  });

  return router;
}

/** Default router instance using the module-level store */
export const investigationRouter = createInvestigationRouter();
/** OpenAPI spec endpoint (no auth required) */
export const openApiRouter = Router();
openApiRouter.get('/', (req, res) => {
  res.json(investigationOpenApiSpec);
});
//# sourceMappingURL=router.js.map
