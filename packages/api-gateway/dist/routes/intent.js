import { Router } from 'express';
import { AnthropicProvider, LLMGateway } from '@agentic-obs/llm-gateway';
import { getSetupConfig } from './setup.js';
import { AlertRuleAgent } from './dashboard/agents/alert-rule-agent.js';
import { defaultAlertRuleStore } from './alert-rule-store.js';
/**
 * SSE-streaming intent endpoint.
 *
 * Flow:
 * 1. Classify intent via LLM (stream progress events)
 * 2. Execute alert - create rule; dashboard/investigate - create workspace
 * 3. Send final "done" event with navigation target
 *
 * The home page stays visible throughout, showing real-time progress.
 */
export function createIntentRouter(dashboardStore) {
    const router = Router();
    router.post('/', async (req, res, _next) => {
        const body = req.body;
        if (!body.message || typeof body.message !== 'string' || body.message.trim() === '') {
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
            const isCorporateGateway = config.llm.provider === 'corporate-gateway' || !!config.llm.tokenHelperCommand;
            const provider = new AnthropicProvider({
                apiKey: config.llm.apiKey,
                baseUrl: config.llm.baseUrl,
                authType: isCorporateGateway
                    ? (config.llm.authType ?? 'bearer')
                    : (config.llm.authType ?? 'api-key'),
                tokenHelperCommand: config.llm.tokenHelperCommand,
            });
            const gateway = new LLMGateway({ primary: provider, maxRetries: 2 });
            // Step 1: Classify intent
            send('thinking', { content: 'Understanding your request...' });
            const classifyResp = await gateway.complete({
                model: config.llm?.model ?? 'claude-sonnet-4-5',
                messages: [
                    {
                        role: 'system', content: `
Return JSON: { "intent": "" }

Possible intents:
- "alert": the user wants to set up an alert, be notified, or monitor a condition with a threshold.
- "dashboard": the user wants to create or view a workspace/dashboard to visualize metrics.
- "investigate": the user is asking about a problem, wants to diagnose an issue, or is troubleshooting.

Classify based on the user's actual, surface-level keywords.
`,
                    },
                    { role: 'user', content: message },
                ],
                maxTokens: 64,
                temperature: 0,
                responseFormat: 'json',
            });
            const cleaned = classifyResp.content.replace(/^```json/i, '').replace(/```/g, '').trim();
            let intent;
            try {
                const parsed = JSON.parse(cleaned);
                intent = parsed.intent;
            }
            catch {
                intent = 'dashboard';
            }
            console.log(`[intent] message="${message.slice(0, 80)}" -> intent="${intent}"`);
            send('intent', { intent });
            // Step 2: Execute based on intent
            if (intent === 'alert') {
                send('thinking', { content: 'Creating alert rule...' });
                const prompt = body.prompt ?? message;
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
                const agent = new AlertRuleAgent({ gateway, model: config.llm.model, prometheusUrl, prometheusHeaders });
                send('thinking', { content: `Validating PromQL: ${generated.condition.query}` });
                const generated = await agent.generate(message);
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
                    summary: `Alert "${rule.name}" created - ${rule.condition.operator} ${rule.condition.threshold}`,
                    navigate: '/alerts',
                });
            }
            else {
                // dashboard or investigate -> create workspace
                const title = intent === 'investigate' ? 'Investigation' : 'Untitled dashboard';
                send('thinking', { content: intent === 'investigate' ? 'Starting investigation...' : 'Setting up dashboard workspace...' });
                const dashboard = await dashboardStore.create({
                    title,
                    description: '',
                    owner: 'system',
                    userId: 'anonymous',
                    datasources: [],
                    webAssistantEnabled: true,
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
