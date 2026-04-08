import { Router } from 'express';
import { randomUUID } from 'crypto';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { handleChatMessage } from './chat-handler.js';
import { VariableResolver } from './variable-resolver.js';
import { getSetupConfig } from '../setup.js';
import { getWorkspaceId } from '../../middleware/workspace-context.js';
import { DashboardService, withDashboardLock } from '../../services/dashboard-service.js';
import { createLogger } from '@agentic-obs/common';
const log = createLogger('dashboard-router');
export function createDashboardRouter(deps) {
    const store = deps.store;
    const conversationStore = deps.conversationStore;
    const investigationReportStore = deps.investigationReportStore;
    const alertRuleStore = deps.alertRuleStore;
    const router = Router();
    // All dashboard routes require authentication
    router.use(authMiddleware);
    // POST /dashboards
    router.post('/', requirePermission('dashboard:create'), async (req, res, next) => {
        try {
            const body = req.body;
            if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'prompt is required and must be a non-empty string' });
                return;
            }
            const userId = req.auth?.sub ?? 'anonymous';
            const workspaceId = getWorkspaceId(req);
            const dashboard = await store.create({
                title: body.title?.trim() ?? 'Untitled Dashboard',
                description: '',
                prompt: body.prompt.trim(),
                userId,
                datasourceIds: body.datasourceIds ?? [],
                useExistingMetrics: body.useExistingMetrics ?? true,
                folder: body.folder,
                workspaceId,
            });
            res.status(201).json(dashboard);
            // Trigger generation in background via the orchestrator agent (same path as chat)
            if (!body.stream) {
                const service = new DashboardService({ store, conversationStore, investigationReportStore, alertRuleStore });
                void withDashboardLock(dashboard.id, async () => {
                    try {
                        await service.handleChatMessage(dashboard.id, dashboard.prompt, () => { });
                    }
                    catch (err) {
                        log.error({ err, dashboardId: dashboard.id }, 'background generation failed');
                        await store.update(dashboard.id, { status: 'failed' });
                    }
                });
            }
        }
        catch (err) {
            next(err);
        }
    });
    // GET /dashboards
    router.get('/', requirePermission('dashboard:read'), async (req, res, next) => {
        try {
            const workspaceId = getWorkspaceId(req);
            let all = await store.findAll();
            // Filter by workspace
            all = all.filter((d) => (d.workspaceId ?? 'default') === workspaceId);
            res.json(all);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /dashboards/:id/export — download as JSON file
    router.get('/:id/export', requirePermission('dashboard:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const dashboard = await store.findById(id);
            if (!dashboard) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            const filename = `${dashboard.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.json(dashboard);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /dashboards/:id
    router.get('/:id', requirePermission('dashboard:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const dashboard = await store.findById(id);
            if (!dashboard) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            const workspaceId = getWorkspaceId(req);
            if ((dashboard.workspaceId ?? 'default') !== workspaceId) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            res.json(dashboard);
        }
        catch (err) {
            next(err);
        }
    });
    // PUT /dashboards/:id
    router.put('/:id', requirePermission('dashboard:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const body = req.body;
            const patch = {};
            if (typeof body.title === 'string')
                patch.title = body.title.trim();
            if (typeof body.description === 'string')
                patch.description = body.description;
            if (body.folder !== undefined)
                patch.folder = body.folder;
            const updated = await store.update(id, patch);
            if (!updated) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            res.json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // DELETE /dashboards/:id
    router.delete('/:id', requirePermission('dashboard:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const deleted = await store.delete(id);
            if (!deleted) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            // Cascade: remove associated conversation messages
            await conversationStore.deleteConversation(id);
            res.status(204).send();
        }
        catch (err) {
            next(err);
        }
    });
    // PUT /dashboards/:id/panels
    router.put('/:id/panels', requirePermission('dashboard:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const body = req.body;
            if (!Array.isArray(body.panels)) {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'panels must be an array' });
                return;
            }
            const updated = await store.updatePanels(id, body.panels);
            if (!updated) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            res.json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // POST /dashboards/:id/panels
    router.post('/:id/panels', requirePermission('dashboard:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const d = await store.findById(id);
            if (!d) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            const body = req.body;
            if (!body.title || typeof body.title !== 'string') {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'title is required' });
                return;
            }
            const panel = { ...body, id: randomUUID() };
            const updated = await store.updatePanels(id, [...d.panels, panel]);
            if (!updated) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            res.status(201).json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // DELETE /dashboards/:id/panels/:panelId
    router.delete('/:id/panels/:panelId', requirePermission('dashboard:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const panelId = req.params['panelId'] ?? '';
            const d = await store.findById(id);
            if (!d) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            const panels = d.panels.filter((p) => p.id !== panelId);
            if (panels.length === d.panels.length) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Panel not found' });
                return;
            }
            await store.updatePanels(id, panels);
            res.status(204).send();
        }
        catch (err) {
            next(err);
        }
    });
    // POST /dashboards/:id/chat
    router.post('/:id/chat', requirePermission('dashboard:write'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const body = req.body;
            if (typeof body.message !== 'string' || body.message.trim() === '') {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'message is required and must be a non-empty string' });
                return;
            }
            await handleChatMessage(req, res, id, body.message.trim(), store, conversationStore, investigationReportStore, alertRuleStore);
        }
        catch (err) {
            next(err);
        }
    });
    // POST /dashboards/:id/variables/resolve
    router.post('/:id/variables/resolve', requirePermission('dashboard:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const dashboard = await store.findById(id);
            if (!dashboard) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            const body = req.body;
            const config = getSetupConfig();
            const datasourceId = body?.datasourceId;
            const promDs = config.datasources.find((d) => (d.type === 'prometheus' || d.type === 'victoria-metrics')
                && (!datasourceId || d.id === datasourceId));
            let prometheusUrl = '';
            const headers = {};
            if (promDs) {
                prometheusUrl = promDs.url;
                if (promDs.username && promDs.password) {
                    headers.Authorization = `Basic ${Buffer.from(`${promDs.username}:${promDs.password}`).toString('base64')}`;
                }
                else if (promDs.apiKey) {
                    headers.Authorization = `Bearer ${promDs.apiKey}`;
                }
            }
            const resolver = new VariableResolver(prometheusUrl, headers);
            const resolved = {};
            await Promise.all(dashboard.variables.map(async (v) => {
                resolved[v.name] = await resolver.resolve(v);
            }));
            res.json({ variables: resolved });
        }
        catch (err) {
            next(err);
        }
    });
    // GET /dashboards/:id/chat
    router.get('/:id/chat', requirePermission('dashboard:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const dashboard = await store.findById(id);
            if (!dashboard) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
            res.json({ messages: await conversationStore.getMessages(id) });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=router.js.map