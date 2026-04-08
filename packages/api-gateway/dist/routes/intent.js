import { Router } from 'express';
import { getSetupConfig } from './setup.js';
import { IntentService } from '../services/intent-service.js';
export function createIntentRouter(deps) {
    const router = Router();
    const intentService = new IntentService({
        dashboardStore: deps.dashboardStore,
        alertRuleStore: deps.alertRuleStore,
        investigationStore: deps.investigationStore,
        feedStore: deps.feedStore,
        reportStore: deps.reportStore,
    });
    router.post('/', async (req, res, _next) => {
        const body = req.body;
        if (!body?.message || typeof body.message !== 'string' || body.message.trim() === '') {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'message is required' });
            return;
        }
        const message = body.message.trim();
        const config = getSetupConfig();
        if (!config.llm) {
            res.status(503).json({ code: 'LLM_NOT_CONFIGURED', message: 'LLM not configured' });
            return;
        }
        // SSE setup
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const send = (type, data) => {
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
            const result = await intentService.processMessage(message, (progress) => {
                send(progress.type, progress.data);
            });
            send('done', result);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            send('error', { message: msg });
        }
        finally {
            res.end();
        }
    });
    return router;
}
//# sourceMappingURL=intent.js.map