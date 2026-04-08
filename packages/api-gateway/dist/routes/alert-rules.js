import { Router } from 'express';
import { defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { AlertRuleService } from '../services/alert-rule-service.js';
import { getWorkspaceId } from '../middleware/workspace-context.js';
export function createAlertRulesRouter(deps = {}) {
    const store = deps.alertRuleStore ?? defaultAlertRuleStore;
    const router = Router();
    const alertRuleService = new AlertRuleService(store);
    // -- POST /api/alert-rules/generate - NL -> alert rule (no dashboard needed)
    // IMPORTANT: must be before /:id routes
    router.post('/generate', async (req, res, next) => {
        try {
            const body = req.body;
            if (!body?.prompt || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
                res.status(400).json({ code: 'INVALID_INPUT', message: 'prompt is required' });
                return;
            }
            const { rule } = await alertRuleService.generateFromPrompt(body.prompt.trim());
            // Stamp workspace on generated rule
            const workspaceId = getWorkspaceId(req);
            if (workspaceId !== 'default') {
                await store.update(rule.id, { workspaceId, labels: { ...rule.labels, workspaceId } });
            }
            res.status(201).json(rule);
        }
        catch (err) {
            if (err?.message?.includes('LLM not configured')) {
                res.status(503).json({ code: 'LLM_NOT_CONFIGURED', message: err.message });
                return;
            }
            next(err);
        }
    });
    // -- Alert Rules CRUD
    router.get('/', async (req, res) => {
        const state = req.query['state'];
        const severity = req.query['severity'];
        const search = req.query['search'];
        const limit = req.query['limit'] ? parseInt(req.query['limit']) : undefined;
        const offset = req.query['offset'] ? parseInt(req.query['offset']) : undefined;
        const workspaceId = getWorkspaceId(req);
        const results = await store.findAll({
            state: state,
            severity,
            search,
            limit,
            offset,
        });
        // Filter by workspace
        results.list = results.list.filter((r) => (r.workspaceId ?? 'default') === workspaceId);
        results.total = results.list.length;
        res.json(results);
    });
    router.get('/:id', async (req, res) => {
        const rule = await store.findById(req.params['id'] ?? '');
        if (!rule) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        res.json(rule);
    });
    router.post('/', async (req, res) => {
        const body = req.body;
        if (!body?.name || !body.condition) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'name and condition are required' });
            return;
        }
        const workspaceId = getWorkspaceId(req);
        const rule = await store.create({
            name: body.name,
            description: body.description ?? '',
            originalPrompt: body.originalPrompt,
            condition: body.condition,
            evaluationIntervalSec: body.evaluationIntervalSec ?? 60,
            severity: body.severity ?? 'medium',
            labels: { ...body.labels, workspaceId },
            createdBy: body.createdBy ?? 'user',
            notificationPolicyId: body.notificationPolicyId,
            workspaceId,
        });
        res.status(201).json(rule);
    });
    router.put('/:id', async (req, res) => {
        const updated = await store.update(req.params['id'] ?? '', req.body);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        res.json(updated);
    });
    router.delete('/:id', async (req, res) => {
        if (!(await store.delete(req.params['id'] ?? ''))) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        res.status(204).end();
    });
    router.post('/:id/disable', async (req, res) => {
        const rule = await store.update(req.params['id'] ?? '', { state: 'disabled' });
        if (!rule) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        res.json(rule);
    });
    router.post('/:id/enable', async (req, res) => {
        const rule = await store.update(req.params['id'] ?? '', { state: 'normal' });
        if (!rule) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        res.json(rule);
    });
    router.get('/:id/history', async (req, res) => {
        const limit = parseInt(req.query['limit'] ?? '50', 10);
        res.json(await store.getHistory(req.params['id'] ?? '', limit));
    });
    router.post('/:id/test', async (req, res, next) => {
        try {
            const rule = await store.findById(req.params['id'] ?? '');
            if (!rule) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
                return;
            }
            res.json({ ok: true, testResult: { message: 'Test endpoint ready - evaluator will be wired in pipeline' } });
        }
        catch (err) {
            next(err);
        }
    });
    router.post('/:id/investigate', async (req, res, next) => {
        try {
            const rule = await store.findById(req.params['id'] ?? '');
            if (!rule) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
                return;
            }
            const body = req.body;
            if (rule.investigationId && !body?.force) {
                res.json({ investigationId: rule.investigationId, existing: true });
                return;
            }
            if (!deps.investigationStore || !deps.feedStore) {
                res.status(503).json({ code: 'NOT_CONFIGURED', message: 'Investigation stores not configured' });
                return;
            }
            const { LiveOrchestratorRunner } = await import('../routes/investigation/live-orchestrator-runner.js');
            const question = `Investigate alert "${rule.name}": ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`;
            const investigation = await deps.investigationStore.create({
                question,
                sessionId: `ses_alert_${Date.now()}`,
                userId: 'alert-system',
            });
            const orchestrator = new LiveOrchestratorRunner(deps.investigationStore, deps.feedStore, deps.reportStore);
            orchestrator.run({
                investigationId: investigation.id,
                question: investigation.intent,
                sessionId: investigation.sessionId,
                userId: investigation.userId,
            });
            await store.update(rule.id, { investigationId: investigation.id });
            res.json({ investigationId: investigation.id, existing: false });
        }
        catch (err) {
            next(err);
        }
    });
    // -- Silences
    router.get('/silences/all', async (_req, res) => {
        res.json(await store.findAllSilencesIncludingExpired());
    });
    router.get('/silences', async (_req, res) => {
        res.json(await store.findSilences());
    });
    router.post('/silences', async (req, res) => {
        const body = req.body;
        if (!body?.matchers || !body?.startsAt || !body?.endsAt) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'matchers, startsAt, endsAt are required' });
            return;
        }
        const silence = await store.createSilence({
            matchers: body.matchers,
            startsAt: body.startsAt,
            endsAt: body.endsAt,
            comment: body.comment ?? '',
            createdBy: body.createdBy ?? 'user',
        });
        res.status(201).json(silence);
    });
    router.put('/silences/:id', async (req, res) => {
        const updated = await store.updateSilence(req.params['id'] ?? '', req.body);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Silence not found' });
            return;
        }
        res.json(updated);
    });
    router.delete('/silences/:id', async (req, res) => {
        if (!(await store.deleteSilence(req.params['id'] ?? ''))) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Silence not found' });
            return;
        }
        res.status(204).end();
    });
    // -- Notification Policies
    router.get('/notification-policies', async (_req, res) => {
        res.json(await store.findAllPolicies());
    });
    router.post('/notification-policies', async (req, res) => {
        const body = req.body;
        if (!body?.name || !body?.channels) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'name and channels are required' });
            return;
        }
        const policy = await store.createPolicy({
            name: body.name,
            matchers: body.matchers ?? [],
            channels: body.channels,
            groupBy: body.groupBy ?? [],
            groupWaitSec: body.groupWaitSec ?? 30,
            groupIntervalSec: body.groupIntervalSec ?? 300,
            repeatIntervalSec: body.repeatIntervalSec ?? 3600,
        });
        res.status(201).json(policy);
    });
    router.put('/notification-policies/:id', async (req, res) => {
        const updated = await store.updatePolicy(req.params['id'] ?? '', req.body);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Notification policy not found' });
            return;
        }
        res.json(updated);
    });
    router.delete('/notification-policies/:id', async (req, res) => {
        if (!(await store.deletePolicy(req.params['id'] ?? ''))) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Notification policy not found' });
            return;
        }
        res.status(204).end();
    });
    return router;
}
// Backward-compatible export for existing code
export const alertRulesRouter = createAlertRulesRouter();
//# sourceMappingURL=alert-rules.js.map