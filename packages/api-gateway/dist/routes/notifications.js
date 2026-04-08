import { Router } from 'express';
import { defaultNotificationStore, defaultAlertRuleStore } from '@agentic-obs/data-layer';
export function createNotificationsRouter(deps = {}) {
    const notifStore = deps.notificationStore ?? defaultNotificationStore;
    const alertStore = deps.alertRuleStore ?? defaultAlertRuleStore;
    const router = Router();
    // -- Contact Points
    // GET /api/notifications/contact-points
    router.get('/contact-points', async (_req, res) => {
        res.json(await notifStore.findAllContactPoints());
    });
    // GET /api/notifications/contact-points/:id
    router.get('/contact-points/:id', async (req, res) => {
        const cp = await notifStore.findContactPointById(req.params['id'] ?? '');
        if (!cp) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Contact point not found' });
            return;
        }
        res.json(cp);
    });
    // POST /api/notifications/contact-points
    router.post('/contact-points', async (req, res) => {
        const body = req.body;
        if (!body?.name) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'name is required' });
            return;
        }
        const cp = await notifStore.createContactPoint({
            name: body.name,
            integrations: body.integrations ?? [],
        });
        res.status(201).json(cp);
    });
    // PUT /api/notifications/contact-points/:id
    router.put('/contact-points/:id', async (req, res) => {
        const updated = await notifStore.updateContactPoint(req.params['id'] ?? '', req.body);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Contact point not found' });
            return;
        }
        res.json(updated);
    });
    // DELETE /api/notifications/contact-points/:id
    router.delete('/contact-points/:id', async (req, res) => {
        const deleted = await notifStore.deleteContactPoint(req.params['id'] ?? '');
        if (!deleted) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Contact point not found' });
            return;
        }
        res.status(204).end();
    });
    // POST /api/notifications/contact-points/:id/test
    router.post('/contact-points/:id/test', async (req, res, next) => {
        try {
            const cp = await notifStore.findContactPointById(req.params['id'] ?? '');
            if (!cp) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Contact point not found' });
                return;
            }
            const results = [];
            for (const integration of cp.integrations) {
                if (integration.type === 'slack'
                    || integration.type === 'webhook'
                    || integration.type === 'discord'
                    || integration.type === 'teams') {
                    const url = integration.settings?.url ?? integration.settings?.webhookUrl ?? '';
                    try {
                        const payload = {
                            text: `Test notification from Agentic Observability Platform - contact point "${cp.name}" is working correctly.`,
                            username: 'Agentic Obs',
                        };
                        const resp = await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload),
                        });
                        results.push({
                            integrationUid: integration.id,
                            type: integration.type,
                            success: resp.ok,
                            message: resp.ok ? 'Test notification sent successfully' : `HTTP ${resp.status}`,
                        });
                    }
                    catch (err) {
                        results.push({
                            integrationUid: integration.id,
                            type: integration.type,
                            success: false,
                            message: err instanceof Error ? err.message : 'Unknown error',
                        });
                    }
                }
                else if (integration.type === 'email' || integration.type === 'pagerduty' || integration.type === 'opsgenie' || integration.type === 'telegram') {
                    results.push({
                        integrationUid: integration.id,
                        type: integration.type,
                        success: true,
                        message: `Mock test for ${integration.type} - configure credentials for live testing`,
                    });
                }
                else {
                    results.push({
                        integrationUid: integration.id,
                        type: integration.type,
                        success: false,
                        message: 'No webhook URL configured',
                    });
                }
            }
            res.json({ contactPointId: cp.id, results });
        }
        catch (err) {
            next(err);
        }
    });
    // -- Policy Tree
    // GET /api/notifications/policies
    router.get('/policies', async (_req, res) => {
        res.json(await notifStore.getPolicyTree());
    });
    // PUT /api/notifications/policies - replace entire tree
    router.put('/policies', async (req, res) => {
        const body = req.body;
        if (!body || !body.id) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'Valid policy tree with id is required' });
            return;
        }
        await notifStore.updatePolicyTree(body);
        res.json(await notifStore.getPolicyTree());
    });
    // POST /api/notifications/policies/:parentId/children
    router.post('/policies/:parentId/children', async (req, res) => {
        const body = req.body;
        if (!body?.contactPointId) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'contactPointId is required' });
            return;
        }
        const newNode = await notifStore.addChildPolicy(req.params['parentId'] ?? '', {
            matchers: body.matchers ?? [],
            contactPointId: body.contactPointId,
            groupBy: body.groupBy ?? ['alertname'],
            groupWaitSec: body.groupWaitSec ?? 30,
            groupIntervalSec: body.groupIntervalSec ?? 300,
            repeatIntervalSec: body.repeatIntervalSec ?? 3600,
            continueMatching: body.continueMatching ?? false,
            muteTimingIds: body.muteTimingIds ?? [],
            isDefault: false,
        });
        if (!newNode) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Parent policy not found' });
            return;
        }
        res.status(201).json(newNode);
    });
    // PUT /api/notifications/policies/:id
    router.put('/policies/:id', async (req, res) => {
        const updated = await notifStore.updatePolicy(req.params['id'] ?? '', req.body);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Policy node not found' });
            return;
        }
        res.json(updated);
    });
    // DELETE /api/notifications/policies/:id
    router.delete('/policies/:id', async (req, res) => {
        const id = req.params['id'] ?? '';
        if (id === 'root') {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'Cannot delete root policy' });
            return;
        }
        const deleted = await notifStore.deletePolicy(id);
        if (!deleted) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Policy node not found' });
            return;
        }
        res.status(204).end();
    });
    // -- Mute Timings
    // GET /api/notifications/mute-timings
    router.get('/mute-timings', async (_req, res) => {
        res.json(await notifStore.findAllMuteTimings());
    });
    // POST /api/notifications/mute-timings
    router.post('/mute-timings', async (req, res) => {
        const body = req.body;
        if (!body?.name) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'name is required' });
            return;
        }
        const mt = await notifStore.createMuteTiming({
            name: body.name,
            timeIntervals: (body.timeIntervals ?? []),
        });
        res.status(201).json(mt);
    });
    // PUT /api/notifications/mute-timings/:id
    router.put('/mute-timings/:id', async (req, res) => {
        const updated = await notifStore.updateMuteTiming(req.params['id'] ?? '', req.body);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Mute timing not found' });
            return;
        }
        res.json(updated);
    });
    // DELETE /api/notifications/mute-timings/:id
    router.delete('/mute-timings/:id', async (req, res) => {
        const deleted = await notifStore.deleteMuteTiming(req.params['id'] ?? '');
        if (!deleted) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Mute timing not found' });
            return;
        }
        res.status(204).end();
    });
    // -- Alert Groups
    // GET /api/notifications/alert-groups
    router.get('/alert-groups', async (_req, res) => {
        const rules = await alertStore.findAll({ state: undefined });
        const activeRules = rules.list.filter((r) => r.state === 'firing' || r.state === 'pending');
        const policyTree = await notifStore.getPolicyTree();
        const groupBy = (policyTree.groupBy?.length ?? 0) > 0 ? policyTree.groupBy : ['alertname'];
        // Group alerts by the root group's label values
        const groupMap = new Map();
        for (const rule of activeRules) {
            const groupLabels = {};
            for (const label of groupBy) {
                groupLabels[label] = rule.labels?.[label] ?? (label === 'alertname' ? rule.name : '');
            }
            const key = groupBy.map((l) => `${l}=${groupLabels[l]}`).join(',');
            if (!groupMap.has(key)) {
                groupMap.set(key, { labels: groupLabels, alerts: [] });
            }
            groupMap.get(key).alerts.push({
                ruleId: rule.id,
                ruleName: rule.name,
                state: rule.state,
                severity: rule.severity,
                labels: rule.labels ?? {},
                startsAt: rule.lastFiredAt ?? rule.stateChangedAt,
            });
        }
        res.json([...groupMap.values()]);
    });
    return router;
}
// Backward-compatible export for existing code
export const notificationsRouter = createNotificationsRouter();
//# sourceMappingURL=notifications.js.map