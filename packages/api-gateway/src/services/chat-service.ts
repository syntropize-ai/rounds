import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';
import type { DashboardSseEvent } from '@agentic-obs/common';
import { getSetupConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';
import { DashboardOrchestratorAgent as OrchestratorAgent } from '@agentic-obs/agent-core';
import type { IDashboardAlertRuleStore as IAlertRuleStore, IDashboardInvestigationStore as IInvestigationStore } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import { resolvePrometheusDatasource } from './dashboard-service.js';
import type { IGatewayDashboardStore, IConversationStore } from '../repositories/types.js';
import type { IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore } from '@agentic-obs/data-layer';

const log = createLogger('chat-service');

/** Adapts data-layer IAlertRuleRepository to agent-core IAlertRuleStore. */
function toAlertRuleStore(repo: IAlertRuleRepository): IAlertRuleStore {
  return {
    create: (data) => repo.create(data as Parameters<IAlertRuleRepository['create']>[0]),
    update: repo.update ? (id, patch) => repo.update(id, patch as Parameters<IAlertRuleRepository['update']>[1]) : undefined,
    findAll: repo.findAll
      ? async () => {
          const result = await repo.findAll();
          return 'list' in result ? result.list : result;
        }
      : undefined,
    findById: repo.findById ? (id) => repo.findById(id) : undefined,
    delete: repo.delete ? (id) => repo.delete(id) : undefined,
  };
}

export interface ChatServiceDeps {
  dashboardStore: IGatewayDashboardStore;
  conversationStore: IConversationStore;
  investigationReportStore: IInvestigationReportRepository;
  alertRuleStore: IAlertRuleRepository;
  investigationStore?: IGatewayInvestigationStore;
}

export interface ChatSessionResult {
  sessionId: string;
  replyContent: string;
  assistantMessageId: string;
  navigate?: string;
}

export class ChatService {
  constructor(private deps: ChatServiceDeps) {}

  async handleMessage(
    message: string,
    sessionId: string | undefined,
    sendEvent: (event: DashboardSseEvent) => void,
  ): Promise<ChatSessionResult> {
    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured - please complete the Setup Wizard first.');
    }

    const resolvedSessionId = sessionId ?? randomUUID();

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model;
    const prom = resolvePrometheusDatasource(config.datasources);

    const metricsAdapter = prom
      ? new PrometheusMetricsAdapter(prom.url, prom.headers)
      : undefined;

    const orchestrator = new OrchestratorAgent({
      gateway,
      model,
      store: this.deps.dashboardStore,
      conversationStore: this.deps.conversationStore,
      investigationReportStore: this.deps.investigationReportStore,
      investigationStore: this.deps.investigationStore as IInvestigationStore | undefined,
      alertRuleStore: toAlertRuleStore(this.deps.alertRuleStore),
      metricsAdapter,
      allDatasources: config.datasources,
      sendEvent,
    }, resolvedSessionId);

    log.info({ sessionId: resolvedSessionId, message: message.slice(0, 80) }, 'starting session orchestrator');
    const replyContent = await orchestrator.handleMessage(message);
    const assistantActions = orchestrator.consumeConversationActions();
    const navigate = orchestrator.consumeNavigate();
    log.info({ sessionId: resolvedSessionId, reply: replyContent.slice(0, 100) }, 'session orchestrator done');

    return { sessionId: resolvedSessionId, replyContent, assistantMessageId: randomUUID(), navigate };
  }
}
