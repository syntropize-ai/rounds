// Investigation API router - all /investigations endpoints
import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { investigationOpenApiSpec } from './openapi.js';
import { initSse, sendSseEvent, sendSseKeepAlive, closeSse } from './sse.js';
import { LiveOrchestratorRunner } from './live-orchestrator-runner.js';
import { getWorkspaceId } from '../../middleware/workspace-context.js';
export function createInvestigationRouter(deps) {
    const store = deps.store;
    const feed = deps.feed;
    const reportStore = deps.reportStore;
    const orchestrator = deps.orchestrator ?? new LiveOrchestratorRunner(store, feed, reportStore);
    const shareRepo = deps.shareRepo;
    const router = Router();
    // All investigation routes require authentication
    router.use(authMiddleware);
    // -- POST /investigations
    router.post('/', requirePermission('investigation:create'), async (req, res, next) => {
        try {
            const body = req.body;
            if (!body?.question || typeof body.question !== 'string' || body.question.trim() === '') {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'question is required and must be a non-empty string' });
                return;
            }
            const authReq = req;
            const workspaceId = getWorkspaceId(req);
            const investigation = await store.create({
                question: body.question.trim(),
                sessionId: body.sessionId ?? `ses_${Date.now()}`,
                userId: authReq.auth?.sub ?? 'anonymous',
                entity: body.entity,
                timeRange: body.timeRange,
                workspaceId,
            });
            // Async orchestration - does not block the HTTP response
            orchestrator.run({
                investigationId: investigation.id,
                question: investigation.intent,
                sessionId: investigation.sessionId,
                userId: investigation.userId,
            });
            res.status(201).json(investigation);
        }
        catch (err) {
            next(err);
        }
    });
    // -- GET /investigations/archived
    // Must be registered before /:id to avoid shadowing
    router.get('/archived', requirePermission('investigation:read'), async (_req, res, next) => {
        try {
            res.json(await store.getArchived());
        }
        catch (err) {
            next(err);
        }
    });
    // -- POST /investigations/archived/:id/restore
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
    // -- GET /investigations
    router.get('/', requirePermission('investigation:read'), async (req, res, next) => {
        try {
            const workspaceId = getWorkspaceId(req);
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
        }
        catch (err) {
            next(err);
        }
    });
    // -- GET /investigations/:id
    router.get('/:id', requirePermission('investigation:read'), async (req, res, next) => {
        try {
            const inv = await store.findById(req.params['id'] ?? '');
            if (!inv) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            const workspaceId = getWorkspaceId(req);
            if ((inv.workspaceId ?? 'default') !== workspaceId) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            res.json(inv);
        }
        catch (err) {
            next(err);
        }
    });
    // -- DELETE /investigations/:id
    router.delete('/:id', requirePermission('investigation:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const inv = await store.findById(id);
            if (!inv) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            const workspaceId = getWorkspaceId(req);
            if ((inv.workspaceId ?? 'default') !== workspaceId) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            await store.delete(id);
            // Cascade: remove associated investigation reports
            const reports = await reportStore.findByDashboard(id);
            for (const r of reports) {
                await reportStore.delete(r.id);
            }
            res.status(204).end();
        }
        catch (err) {
            next(err);
        }
    });
    // -- GET /investigations/:id/report
    router.get('/:id/report', requirePermission('investigation:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const inv = await store.findById(id);
            if (!inv) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            // Reports are stored with investigationId in the dashboardId field
            const reports = await reportStore.findByDashboard(id);
            if (!reports.length) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Report not yet available' });
                return;
            }
            res.json(reports[reports.length - 1]);
        }
        catch (err) {
            next(err);
        }
    });
    // -- GET /investigations/:id/plan
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
    // -- POST /investigations/:id/follow-up
    router.post('/:id/follow-up', requirePermission('investigation:create'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const inv = await store.findById(id);
            if (!inv) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            const body = req.body;
            if (!body?.question || typeof body.question !== 'string' || body.question.trim() === '') {
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
    // -- POST /investigations/:id/feedback
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
    // -- GET /investigations/:id/conclusion
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
    // -- POST /investigations/:id/share
    router.post('/:id/share', requirePermission('investigation:write'), async (req, res, next) => {
        try {
            const authReq = req;
            const id = req.params['id'] ?? '';
            const inv = await store.findById(id);
            if (!inv) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
                return;
            }
            const body = req.body;
            const link = await shareRepo.create({
                investigationId: id,
                createdBy: authReq.auth?.sub ?? 'unknown',
                permission: body?.permission ?? 'view_only',
                expiresInMs: body?.expiresInMs,
            });
            res.status(201).json({
                token: link.token,
                shareUrl: `/api/shared/${link.token}`,
                permission: link.permission,
                expiresAt: link.expiresAt,
            });
        }
        catch (err) {
            next(err);
        }
    });
    // -- GET /investigations/:id/shares
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
    // -- GET /investigations/:id/stream (SSE)
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
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
// OpenAPI spec endpoint (no auth required)
export const openApiRouter = Router();
openApiRouter.get('/', (_req, res) => {
    res.json(investigationOpenApiSpec);
});
//# sourceMappingURL=router.js.map