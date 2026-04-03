import { Router } from 'express';
import { getSetupConfig } from './setup.js';
import { createLlmGateway } from './llm-factory.js';
import { AlertRuleAgent } from './dashboard/agents/alert-rule-agent.js';
import { defaultAlertRuleStore } from './alert-rule-store.js';
// SSE-streaming intent endpoint.
//
// Flow:
// 1. Classify intent via LLM (stream progress events)
// 2. Execute alert rule; dashboard/investigate -> create workspace
// 3. Send final "done" event with navigation target
//
// The home page stays visible throughout, showing real-time progress.
export function createIntentRouter(dashboardStore) {
    const router = Router();
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
            const gateway = createLlmGateway(config.llm);
            const model = config.llm.model || 'claude-sonnet-4-6';
            // -- Step 1: classify intent
            send('thinking', { content: 'Understanding your request...' });
            const classifyResp = await gateway.complete([
                {
                    role: 'system',
                    content: `You are an intent classifier for an observability platform. Classify the user's message into exactly one intent.\n\n`
                        + `Return JSON: { "intent": "<intent>" }\n\n`
                        + `Possible intents:\n`
                        + `- "alert": The user wants to set up an alert, be notified, or monitor a condition with a threshold.\n`
                        + `- "dashboard": The user wants to create or view a monitoring dashboard to visualize metrics.\n`
                        + `- "investigate": The user is asking about a problem, wants to diagnose an issue, or is troubleshooting.\n\n`
                        + `Classify based on the user's actual goal, not surface-level keywords.`,
                },
                { role: 'user', content: message },
            ], {
                model,
                maxTokens: 64,
                temperature: 0,
                responseFormat: 'json',
            });
            const cleaned = classifyResp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
            let intent;
            try {
                const parsed = JSON.parse(cleaned);
                intent = parsed.intent ?? 'dashboard';
            }
            catch {
                intent = 'dashboard';
            }
            console.log(`[Intent] message="${message.slice(0, 80)}" -> intent="${intent}"`);
            send('intent', { intent });
            // -- Step 2: Execute based on intent
            if (intent === 'alert') {
                send('thinking', { content: 'Creating alert rule...' });
                const promDs = config.datasources.find((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');
                const prometheusUrl = promDs?.url;
                const prometheusHeaders = {};
                if (promDs?.username && promDs?.password) {
                    prometheusHeaders['Authorization']
                        = `Basic ${Buffer.from(`${promDs.username}:${promDs.password}`).toString('base64')}`;
                }
                else if (promDs?.apiKey) {
                    prometheusHeaders['Authorization'] = `Bearer ${promDs.apiKey}`;
                }
                const agent = new AlertRuleAgent({ gateway, model, prometheusUrl, prometheusHeaders });
                const generated = await agent.generate(message);
                send('thinking', { content: `Validating PromQL: ${generated.condition.query}` });
                const rule = defaultAlertRuleStore.create({
                    name: generated.name,
                    description: generated.description,
                    originalPrompt: message,
                    condition: generated.condition,
                    evaluationIntervalSec: generated.evaluationIntervalSec,
                    severity: generated.severity,
                    labels: generated.labels,
                    createdBy: 'llm',
                });
                send('done', {
                    intent: 'alert',
                    alertRuleId: rule.id,
                    summary: `Alert "${rule.name}" created: ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`,
                    navigate: '/alerts',
                });
            }
            else {
                // dashboard or investigate -> create workspace
                const title = intent === 'investigate' ? 'Investigation' : 'Untitled Dashboard';
                send('thinking', {
                    content: intent === 'investigate'
                        ? 'Starting investigation...'
                        : 'Setting up dashboard workspace...',
                });
                const dashboard = await dashboardStore.create({
                    title,
                    description: '',
                    prompt: message,
                    userId: 'anonymous',
                    datasourceIds: [],
                    useExistingMetrics: true,
                });
                send('done', {
                    intent,
                    dashboardId: dashboard.id,
                    navigate: `/dashboards/${dashboard.id}`,
                });
            }
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