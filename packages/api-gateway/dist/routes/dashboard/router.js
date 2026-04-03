import { Router } from 'express';
import { randomUUID } from 'crypto';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { LiveDashboardGenerator } from './generator.js';
import { defaultConversationStore } from './conversation-store.js';
import { handleChatMessage } from './chat-handler.js';
import { VariableResolver } from './variable-resolver.js';
import { defaultInvestigationReportStore } from './investigation-report-store.js';
import { getSetupConfig } from '../setup.js';
export function createDashboardRouter(deps = {}) {
    const store = deps.store;
    const generator = deps.generator ?? new LiveDashboardGenerator(store);
    const conversationStore = deps.conversationStore ?? defaultConversationStore;
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
            const dashboard = await store.create({
                title: body.title?.trim() ?? 'Untitled Dashboard',
                description: '',
                prompt: body.prompt.trim(),
                userId,
                datasourceIds: body.datasourceIds ?? [],
                useExistingMetrics: body.useExistingMetrics ?? true,
                folder: body.folder,
            });
            // When stream=true, skip background generation - client will use POST /:id/chat for SSE
            if (!body.stream) {
                generator.generate(dashboard.id, dashboard.prompt, userId);
            }
            res.status(201).json(dashboard);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /dashboards
    router.get('/', requirePermission('dashboard:read'), async (req, res, next) => {
        try {
            const typeFilter = req.query['type'];
            let all = await store.findAll();
            if (typeFilter) {
                all = all.filter((d) => d.type === typeFilter);
            }
            else {
                // By default, exclude investigations from the dashboard list
                all = all.filter((d) => d.type !== 'investigation');
            }
            res.json(all);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /dashboards/investigations
    // IMPORTANT: these routes must be defined before /:id to avoid Express treating investigations as an id
    router.get('/investigations', requirePermission('dashboard:read'), (_req, res) => {
        res.json(defaultInvestigationReportStore.findAll());
    });
    // GET /dashboards/investigations/:reportId
    router.get('/investigations/:reportId', requirePermission('dashboard:read'), (req, res) => {
        const report = defaultInvestigationReportStore.findById(req.params['reportId'] ?? '');
        if (!report) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation report not found' });
            return;
        }
        res.json(report);
    });
    // DELETE /dashboards/investigations/:reportId
    router.delete('/investigations/:reportId', requirePermission('dashboard:write'), (req, res) => {
        const deleted = defaultInvestigationReportStore.delete(req.params['reportId'] ?? '');
        if (!deleted) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation report not found' });
            return;
        }
        res.status(204).send();
    });
    // GET /dashboards/:id/investigation-report
    router.get('/:id/investigation-report', requirePermission('dashboard:read'), (req, res) => {
        const reports = defaultInvestigationReportStore.findByDashboard(req.params['id'] ?? '');
        if (!reports.length) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'No investigation report for this dashboard' });
            return;
        }
        // Return the most recent one
        res.json(reports[reports.length - 1]);
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
            const deleted = await store.delete(req.params['id'] ?? '');
            if (!deleted) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
                return;
            }
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
            await handleChatMessage(req, res, id, body.message.trim(), store, conversationStore);
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
            res.json({ messages: conversationStore.getMessages(id) });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
// Default router instance using the module-level store
export const dashboardRouter = createDashboardRouter();
//# sourceMappingURL=router.js.map