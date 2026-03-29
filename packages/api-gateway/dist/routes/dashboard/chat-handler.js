import { randomUUID } from 'crypto';
import { AnthropicProvider, LLMGateway } from '@agentic-obs/llm-gateways';
import { getSetupConfig } from './setup.js';
import { OrchestratorAgent } from './agents/orchestrator-agent.js';

function sendEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const dashboardLocks = new Map();

async function withDashboardLock(dashboardId, fn) {
  const prev = dashboardLocks.get(dashboardId) ?? Promise.resolve();
  let resolve;
  const next = new Promise((r) => { resolve = r; });
  dashboardLocks.set(dashboardId, next);
  await prev;
  try {
    return await fn();
  }
  finally {
    resolve();
    if (dashboardLocks.get(dashboardId) === next) {
      dashboardLocks.delete(dashboardId);
    }
  }
}

export async function handleChatMessage(req, res, dashboardId, message, store, conversationStore) {
  const dashboard = await store.findById(dashboardId);
  if (!dashboard) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  // Heartbeat every 30s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    if (!closed) {
      res.write(': heartbeat\n\n');
    }
  }, 30000);

  try {
    // Save user message
    const userMessageId = randomUUID();
    conversationStore.addMessage(dashboardId, {
      id: userMessageId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });
    if (closed) {
      return;
    }

    await withDashboardLock(dashboardId, async () => {
      const config = await getSetupConfig();
      if (!config.llm) {
        sendEvent(res, { type: 'error', message: 'LLM not configured - Please complete the Setup Wizard first.' });
        return;
      }

      const isCorporateGateway = config.llm.provider === 'corporate-gateway' || !!config.llm.tokenHelperCommand;
      const provider = new AnthropicProvider({
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseURL,
        authType: isCorporateGateway
          ? (config.llm.authType ?? 'bearer')
          : (config.llm.authType ?? 'api-key'),
        tokenHelperCommand: config.llm.tokenHelperCommand,
      });
      const gateway = new LLMGateway({ primary: provider, maxRetries: 2 });
      const model = config.llm.model || 'claude-sonnet-4-5';

      // Resolve default/primary prometheus datasource
      const prometheusSources = config.datasources.filter((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');
      const promDs = prometheusSources.find((d) => d.isDefault) ?? prometheusSources[0];
      const prometheusHeaders = {};
      if (promDs?.username && promDs?.password) {
        prometheusHeaders['Authorization'] = `Basic ${Buffer.from(`${promDs.username}:${promDs.password}`).toString('base64')}`;
      }
      else if (promDs?.apiKey) {
        prometheusHeaders['Authorization'] = `Bearer ${promDs.apiKey}`;
      }

      const orchestrator = new OrchestratorAgent({
        gateway,
        model,
        store,
        conversationStore,
        prometheusUrl: promDs?.url,
        prometheusHeaders,
        datasources: config.datasources,
        sendEvent: (event) => { if (!closed) sendEvent(res, event); },
      });

      console.log(`[ChatHandler] Starting orchestrator for dashboard=${dashboardId} message="${message.slice(0, 80)}"`);
      const replyContent = await orchestrator.handleMessage(dashboardId, message);
      console.log(`[ChatHandler] Orchestrator done. Reply="${replyContent.slice(0, 100)}"`);

      // Save assistant message
      const assistantMessageId = randomUUID();
      conversationStore.addMessage(dashboardId, {
        id: assistantMessageId,
        role: 'assistant',
        content: replyContent,
        timestamp: new Date().toISOString(),
      });

      if (closed) {
        return;
      }
      sendEvent(res, { type: 'done', messageId: assistantMessageId });
    });
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : 'internal error';
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
  }
  finally {
    clearInterval(heartbeat);
    res.end();
  }
}
//# sourceMappingURL=chat-handler.js.map
