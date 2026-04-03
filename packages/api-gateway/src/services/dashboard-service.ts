import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';
import type { DashboardSseEvent } from '@agentic-obs/common';

const log = createLogger('dashboard-service');
import type { IGatewayDashboardStore, IConversationStore } from '../repositories/types.js';
import { defaultInvestigationReportStore, defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { getSetupConfig, type DatasourceConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';
import { DashboardOrchestratorAgent as OrchestratorAgent } from '@agentic-obs/agent-core';

// -- Prometheus resolution (shared across services)

export interface PrometheusDatasource {
  url: string;
  headers: Record<string, string>;
}

export function resolvePrometheusDatasource(datasources: DatasourceConfig[]): PrometheusDatasource | undefined {
  const promDatasources = datasources.filter((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');
  const prom = promDatasources.find((d) => d.isDefault) ?? promDatasources[0];
  if (!prom) return undefined;

  const headers: Record<string, string> = {};
  if (prom.username && prom.password) {
    headers.Authorization = `Basic ${Buffer.from(`${prom.username}:${prom.password}`).toString('base64')}`;
  } else if (prom.apiKey) {
    headers.Authorization = `Bearer ${prom.apiKey}`;
  }

  return { url: prom.url, headers };
}

// -- Dashboard lock (prevents concurrent mutations on same dashboard)

const dashboardLocks = new Map<string, Promise<void>>();

export async function withDashboardLock<T>(dashboardId: string, fn: () => Promise<T>): Promise<T> {
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  const wait = dashboardLocks.get(dashboardId) ?? Promise.resolve();
  dashboardLocks.set(dashboardId, next);
  await wait;
  try {
    return await fn();
  } finally {
    resolve!();
    if (dashboardLocks.get(dashboardId) === next) {
      dashboardLocks.delete(dashboardId);
    }
  }
}

// -- Dashboard Chat Service

export interface ChatResult {
  replyContent: string;
  assistantMessageId: string;
}

export class DashboardService {
  constructor(
    private store: IGatewayDashboardStore,
    private conversationStore: IConversationStore,
  ) {}

  /**
   * Process a chat message for a dashboard.
   * Business logic only — no HTTP/SSE concerns.
   */
  async handleChatMessage(
    dashboardId: string,
    message: string,
    sendEvent: (event: DashboardSseEvent) => void,
  ): Promise<ChatResult> {
    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured - please complete the Setup Wizard first.');
    }

    // Save user message
    const userMessageId = randomUUID();
    this.conversationStore.addMessage(dashboardId, {
      id: userMessageId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model;
    const prom = resolvePrometheusDatasource(config.datasources);

    const orchestrator = new OrchestratorAgent({
      gateway,
      model,
      store: this.store,
      conversationStore: this.conversationStore,
      investigationReportStore: defaultInvestigationReportStore,
      alertRuleStore: defaultAlertRuleStore,
      prometheusUrl: prom?.url,
      prometheusHeaders: prom?.headers ?? {},
      allDatasources: config.datasources,
      sendEvent,
    });

    log.info({ dashboardId, message: message.slice(0, 80) }, 'starting orchestrator');
    const replyContent = await orchestrator.handleMessage(dashboardId, message);
    log.info({ dashboardId, reply: replyContent.slice(0, 100) }, 'orchestrator done');

    // Save assistant message
    const assistantMessageId = randomUUID();
    this.conversationStore.addMessage(dashboardId, {
      id: assistantMessageId,
      role: 'assistant',
      content: replyContent,
      timestamp: new Date().toISOString(),
    });

    return { replyContent, assistantMessageId };
  }
}
