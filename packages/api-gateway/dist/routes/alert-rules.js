import { Router } from 'express';
import { AnthropicProvider, UIChatGateway } from '@agentic-obs/llm-gateway';
import { defaultAlertRuleStore } from './alert-rule-store.js';
import { AlertRuleAgent } from './dashboard/agents/alert-rule-agent.js';
import { getSetupConfig } from './setup.js';
const router = Router();
// -- POST /api/alert-rules/generate - NL -> alert rule (no dashboard needed) --
// IMPORTANT: Must be before /:id routes
router.post('/generate', async (req, res, next) => {
    try {
        const body = req.body;
        if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'prompt is required' });
            return;
        }
        const config = getSetupConfig();
        if (!config.llm) {
            res.status(503).json({ code: 'LLM_NOT_CONFIGURED', message: 'LLM not configured - complete Setup Wizard first' });
            return;
        }
        const isCorporateGateway = config.llm.provider === 'corporate-gateway' || !!config.llm.tokenHelperCommand;
        const provider = isCorporateGateway
            ? new AnthropicProvider({
                apiKey: config.llm.apiKey,
                baseUrl: config.llm.baseUrl,
                authType: config.llm.authType === 'bearer'
                    ? 'bearer'
                    : config.llm.authType ?? 'api-key',
                tokenHelperCommand: config.llm.tokenHelperCommand,
            })
            : undefined;
        const gateway = new UIChatGateway({ primary: provider, maxRetries: 2 });
        const ds = config.datasources?.find(d => d.type === 'prometheus' || d.type === 'victoria-metrics');
        const prometheusUrl = ds?.url ?? '';
        const prometheusHeaders = {};
        if (ds?.auth?.password) {
            prometheusHeaders['Authorization'] =
                `Basic ${Buffer.from(`${ds?.auth?.username}:${ds?.auth?.password}`).toString('base64')}`;
        }
        else if (ds?.auth?.apiKey) {
            prometheusHeaders['Authorization'] = `Bearer ${ds?.auth?.apiKey}`;
        }
        const agent = new AlertRuleAgent({ gateway, model, prometheusUrl, prometheusHeaders });
        const generated = await agent.generate(body.prompt.trim());
        const rule = defaultAlertRuleStore.create({
            description: generated.description,
            originalPrompt: body.prompt.trim(),
            condition: generated.condition,
            evaluationIntervalSec: generated.evaluationIntervalSec,
            severity: generated.severity,
            labels: generated.labels,
            createdBy: 'user',
        });
        res.status(201).json(rule);
    }
    catch (err) {
        next(err);
    }
});
// -- Alert Rules CRUD --
// GET /api/alert-rules
router.get('/', (req, res) => {
    const state = req.query['state'];
    const severity = req.query['severity'];
    const search = req.query['search'];
    const limit = req.query['limit'] ? parseInt(req.query['limit']) : undefined;
    const offset = req.query['offset'] ? parseInt(req.query['offset']) : undefined;
    const result = defaultAlertRuleStore.findAll({
        state,
        severity,
        search,
        limit,
        offset,
    });
    res.json(result);
});
// GET /api/alert-rules/:id
router.get('/:id', (req, res) => {
    const rule = defaultAlertRuleStore.findById(req.params['id'] ?? '');
    if (!rule) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
        return;
    }
    res.json(rule);
});
// POST /api/alert-rules - create from structured data
router.post('/', (req, res) => {
    const body = req.body;
    if (!body.name || !body.condition) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'name and condition are required' });
        return;
    }
    const rule = defaultAlertRuleStore.create({
        name: body.name,
        description: body.description ?? '',
        originalPrompt: body.originalPrompt,
        condition: body.condition,
        evaluationIntervalSec: body.evaluationIntervalSec ?? 60,
        severity: body.severity ?? 'medium',
        labels: body.labels ?? {},
        createdBy: 'user',
        notificationPolicyId: body.notificationPolicyId,
    });
    res.status(201).json(rule);
});
// PUT /api/alert-rules/:id
router.put('/:id', (req, res) => {
    const updated = defaultAlertRuleStore.update(req.params['id'] ?? '', req.body);
    if (!updated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
        return;
    }
    res.json(updated);
});
// DELETE /api/alert-rules/:id
router.delete('/:id', (req, res) => {
    const deleted = defaultAlertRuleStore.delete(req.params['id'] ?? '');
    if (!deleted) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
        return;
    }
    res.status(204).end();
});
// POST /api/alert-rules/:id/disable
router.post('/:id/disable', (req, res) => {
    const rule = defaultAlertRuleStore.update(req.params['id'] ?? '', { state: 'disabled' });
    if (!rule) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
        return;
    }
    res.json(rule);
});
// POST /api/alert-rules/:id/enable
router.post('/:id/enable', (req, res) => {
    const rule = defaultAlertRuleStore.update(req.params['id'] ?? '', { state: 'normal' });
    if (!rule) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
        return;
    }
    res.json(rule);
});
// GET /api/alert-rules/:id/history
router.get('/:id/history', (req, res) => {
    const limit = parseInt(req.query['limit'] || 50);
    const history = defaultAlertRuleStore.getHistory(req.params['id'] ?? '', limit);
    res.json(history);
});
// POST /api/alert-rules/:id/test - test evaluate without changing state
router.post('/:id/test', async (req, res, next) => {
    try {
        const rule = defaultAlertRuleStore.findById(req.params['id'] ?? '');
        if (!rule) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        // Placeholder - the actual PromQL evaluation will be wired in the pipeline.
        res.json({ rule, testResult: { message: 'Test endpoint ready - evaluator will be wired in @pilot' } });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/alert-rules/:id/investigate - create investigation dashboard for a firing alert
router.post('/:id/investigate', async (req, res, next) => {
    try {
        const rule = defaultAlertRuleStore.findById(req.params['id'] ?? '');
        if (!rule) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
            return;
        }
        const body = req.body;
        if (rule.investigationId && body?.force !== true) {
            res.json({ investigationId: rule.investigationId, existing: true });
            return;
        }
        // Create a dashboard - the frontend will send the investigation prompt via normal chat flow / SSE streaming
        const dashboardStore = await import('./dashboard/store.js');
        const existing = await import('./conversation-store.js');
        const dashboard = typeof dashboardStore.defaultDashboardStore?.create === 'function'
            ? dashboardStore.defaultDashboardStore.create({
                title: `Investigate: ${rule.name}`,
                description: `Auto-created from alert: ${rule.description}`,
                owner: 'system',
                labels: {
                    alertId: rule.id,
                    alertSeverity: rule.severity,
                },
                sources: [rule.condition.query],
                template: 'alert-investigation',
            })
            : { id: `inv_${Date.now()}` };
        defaultAlertRuleStore.update(rule.id, { investigationId: dashboard.id });
        const investigatePrompt = body?.prompt ?? `Investigate alert ${rule.name}`;
        res.json({ investigationId: dashboard.id, prompt: investigatePrompt, existing: false });
    }
    catch (err) {
        next(err);
    }
});
// -- Silences --
// GET /api/alert-rules/silences/all - must be before /silences/:id
router.get('/silences/all', (_req, res) => {
    res.json(defaultAlertRuleStore.findAllSilencesIncludingExpired());
});
// GET /api/alert-rules/silences
router.get('/silences', (_req, res) => {
    res.json(defaultAlertRuleStore.findAllSilences());
});
// POST /api/alert-rules/silences
router.post('/silences', (req, res) => {
    const body = req.body;
    if (!body.matchers || !body.startsAt || !body.endsAt) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'matchers, startsAt, endsAt are required' });
        return;
    }
    const silence = defaultAlertRuleStore.createSilence({
        matchers: body.matchers,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        comment: body.comment ?? '',
        createdBy: body.createdBy ?? 'user',
    });
    res.status(201).json(silence);
});
// PUT /api/alert-rules/silences/:id
router.put('/silences/:id', (req, res) => {
    const updated = defaultAlertRuleStore.updateSilence(req.params['id'] ?? '', req.body);
    if (!updated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Silence not found' });
        return;
    }
    res.json(updated);
});
// DELETE /api/alert-rules/silences/:id
router.delete('/silences/:id', (req, res) => {
    const deleted = defaultAlertRuleStore.deleteSilence(req.params['id'] ?? '');
    if (!deleted) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Silence not found' });
        return;
    }
    res.status(204).end();
});
// -- Notification Policies --
// GET /api/alert-rules/notification-policies
router.get('/notification-policies', (_req, res) => {
    res.json(defaultAlertRuleStore.findAllPolicies());
});
// POST /api/alert-rules/notification-policies
router.post('/notification-policies', (req, res) => {
    const body = req.body;
    if (!body.name || !body.channels) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'name and channels are required' });
        return;
    }
    const policy = defaultAlertRuleStore.createPolicy({
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
// PUT /api/alert-rules/notification-policies/:id
router.put('/notification-policies/:id', (req, res) => {
    const updated = defaultAlertRuleStore.updatePolicy(req.params['id'] ?? '', req.body);
    if (!updated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Notification policy not found' });
        return;
    }
    res.json(updated);
});
// DELETE /api/alert-rules/notification-policies/:id
router.delete('/notification-policies/:id', (req, res) => {
    const deleted = defaultAlertRuleStore.deletePolicy(req.params['id'] ?? '');
    if (!deleted) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Notification policy not found' });
        return;
    }
    res.status(204).end();
});
export { router as alertRulesRouter };
//# sourceMappingURL=alert-rules.js.map
