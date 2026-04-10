import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';
import type { DashboardSseEvent } from '@agentic-obs/common';
import type {
  IAlertRuleRepository,
  IGatewayFeedStore,
  IGatewayInvestigationStore,
  IInvestigationReportRepository,
} from '@agentic-obs/data-layer';
import type { IGatewayDashboardStore, IConversationStore } from '../repositories/types.js';
import { DashboardService, type ChatTimeRange } from './dashboard-service.js';
import { IntentService } from './intent-service.js';
import { getSetupConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';

const log = createLogger('agent-chat-service');

type AgentRouteEvent =
  | DashboardSseEvent
  | { type: 'intent'; data: unknown }
  | { type: 'thinking'; data: unknown };

export type AgentChatContext =
  | { kind: 'home' }
  | { kind: 'dashboard'; id: string }
  | { kind: 'investigation'; id: string };

export interface AgentChatResult {
  intent?: string;
  navigate?: string;
  replyContent?: string;
  assistantMessageId?: string;
  sessionId?: string;
}

export interface AgentChatServiceDeps {
  dashboardStore: IGatewayDashboardStore;
  conversationStore: IConversationStore;
  investigationReportStore: IInvestigationReportRepository;
  alertRuleStore: IAlertRuleRepository;
  investigationStore?: IGatewayInvestigationStore;
  feedStore?: IGatewayFeedStore;
}

export class AgentChatService {
  private readonly dashboardStore: IGatewayDashboardStore;
  private readonly conversationStore: IConversationStore;
  private readonly investigationReportStore: IInvestigationReportRepository;
  private readonly alertRuleStore: IAlertRuleRepository;
  private readonly investigationStore?: IGatewayInvestigationStore;
  private readonly feedStore?: IGatewayFeedStore;

  constructor(deps: AgentChatServiceDeps) {
    this.dashboardStore = deps.dashboardStore;
    this.conversationStore = deps.conversationStore;
    this.investigationReportStore = deps.investigationReportStore;
    this.alertRuleStore = deps.alertRuleStore;
    this.investigationStore = deps.investigationStore;
    this.feedStore = deps.feedStore;
  }

  async chat(
    message: string,
    context: AgentChatContext,
    sendEvent: (event: AgentRouteEvent) => void,
    timeRange?: ChatTimeRange,
    sessionId?: string,
  ): Promise<AgentChatResult> {
    switch (context.kind) {
      case 'home':
        return this.handleHomeChat(message, sendEvent, sessionId);
      case 'dashboard':
        return this.handleDashboardChat(context.id, message, sendEvent as (event: DashboardSseEvent) => void, timeRange, sessionId);
      case 'investigation':
        return this.handleInvestigationChat(context.id, message, sendEvent, sessionId);
      default:
        throw new Error('Unsupported agent chat context');
    }
  }

  private async handleHomeChat(
    message: string,
    sendEvent: (event: AgentRouteEvent) => void,
    sessionId?: string,
  ): Promise<AgentChatResult> {
    const intentService = new IntentService({
      dashboardStore: this.dashboardStore,
      alertRuleStore: this.alertRuleStore,
      investigationStore: this.investigationStore,
      feedStore: this.feedStore,
      reportStore: this.investigationReportStore,
    });

    const result = await intentService.processMessage(message, (progress) => {
      if (progress.type === 'thinking') {
        sendEvent({ type: 'thinking', data: progress.data });
      } else if (progress.type === 'intent') {
        sendEvent({ type: 'intent', data: progress.data });
      }
    });
    return {
      ...result,
      sessionId: sessionId ?? `ses_${Date.now()}`,
    };
  }

  private async handleDashboardChat(
    dashboardId: string,
    message: string,
    sendEvent: (event: DashboardSseEvent) => void,
    timeRange?: ChatTimeRange,
    sessionId?: string,
  ): Promise<AgentChatResult> {
    const service = new DashboardService({
      store: this.dashboardStore,
      conversationStore: this.conversationStore,
      investigationReportStore: this.investigationReportStore,
      alertRuleStore: this.alertRuleStore,
      investigationStore: this.investigationStore,
      feedStore: this.feedStore,
    });
    const result = await service.handleChatMessage(dashboardId, message, timeRange, sendEvent);
    return {
      navigate: result.navigate ?? `/dashboards/${dashboardId}`,
      replyContent: result.replyContent,
      assistantMessageId: result.assistantMessageId,
      sessionId: sessionId ?? `ses_dash_${dashboardId}`,
    };
  }

  private async handleInvestigationChat(
    investigationId: string,
    message: string,
    sendEvent: (event: AgentRouteEvent) => void,
    sessionId?: string,
  ): Promise<AgentChatResult> {
    if (!this.investigationStore) {
      throw new Error('Investigation store is not configured');
    }

    const investigation = await this.investigationStore.findById(investigationId);
    if (!investigation) {
      throw new Error('Investigation not found');
    }

    const intentService = new IntentService({
      dashboardStore: this.dashboardStore,
      alertRuleStore: this.alertRuleStore,
      investigationStore: this.investigationStore,
      feedStore: this.feedStore,
      reportStore: this.investigationReportStore,
    });

    sendEvent({ type: 'thinking', data: { content: 'Understanding your follow-up...' } });

    const intent = await intentService.classifyIntent(message);
    sendEvent({ type: 'intent', data: { intent } });

    if (intent === 'dashboard') {
      sendEvent({ type: 'thinking', data: { content: 'Creating a dashboard from this investigation context...' } });
      const result = await intentService.executeDashboardIntent(
        `${message}\n\nContext from investigation "${investigation.intent}": ${investigation.plan?.objective ?? investigation.intent}`,
      );
      sendEvent({
        type: 'reply',
        content: 'I created a dashboard based on this investigation context and opened it for you.',
      } as DashboardSseEvent);
      return { ...result, sessionId: sessionId ?? investigation.sessionId };
    }

    if (intent === 'alert') {
      sendEvent({ type: 'thinking', data: { content: 'Creating an alert from this investigation context...' } });
      const result = await intentService.executeAlertIntent(
        `${message}\n\nContext from investigation "${investigation.intent}": ${investigation.plan?.objective ?? investigation.intent}`,
      );
      sendEvent({
        type: 'reply',
        content: 'I created an alert rule from this investigation context.',
      } as DashboardSseEvent);
      return { ...result, sessionId: sessionId ?? investigation.sessionId };
    }

    const reportCandidates = await this.investigationReportStore.findByDashboard(investigationId);
    const latestReport = reportCandidates[reportCandidates.length - 1];
    const conclusion = await this.investigationStore.getConclusion(investigationId);
    const lower = message.toLowerCase();
    const asksForDeeperInvestigation = /(follow up|deeper|deep dive|continue|investigate more|再查|继续调查|深入|细查)/i.test(lower);

    if (asksForDeeperInvestigation && this.feedStore) {
      sendEvent({ type: 'thinking', data: { content: 'Starting a follow-up investigation...' } });
      const followUpPrompt = [
        message,
        `Original investigation: ${investigation.intent}`,
        conclusion?.summary ? `Prior conclusion: ${conclusion.summary}` : '',
        latestReport?.summary ? `Prior report: ${latestReport.summary}` : '',
      ].filter(Boolean).join('\n\n');
      const result = await intentService.executeInvestigateIntent(followUpPrompt);
      sendEvent({
        type: 'reply',
        content: 'I started a follow-up investigation so we can dig deeper from the current findings.',
      } as DashboardSseEvent);
      return { ...result, sessionId: sessionId ?? investigation.sessionId };
    }

    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured - please complete the Setup Wizard first.');
    }

    const gateway = createLlmGateway(config.llm);
    const response = await gateway.complete([
      {
        role: 'system',
        content: 'You are PRISM, a unified observability agent. Answer the user using the current investigation context. Be concise, direct, and grounded in the supplied investigation data. If the evidence is incomplete, say what is known and what is still uncertain.',
      },
      {
        role: 'user',
        content: [
          `Current investigation title: ${investigation.intent}`,
          `Status: ${investigation.status}`,
          investigation.plan?.objective ? `Objective: ${investigation.plan.objective}` : '',
          conclusion?.summary ? `Conclusion summary: ${conclusion.summary}` : '',
          latestReport?.summary ? `Report summary: ${latestReport.summary}` : '',
          latestReport?.sections?.length ? `Report sections: ${latestReport.sections.map((section) => section.content ?? section.panel?.title ?? section.type).join('\n')}` : '',
          `User follow-up: ${message}`,
        ].filter(Boolean).join('\n\n'),
      },
    ], {
      model: config.llm.model,
      maxTokens: 400,
      temperature: 0.2,
    });

    const reply = response.content.trim() || 'I reviewed the current investigation and summarized the latest findings.';
    sendEvent({ type: 'reply', content: reply } as DashboardSseEvent);
    log.info({ investigationId, message: message.slice(0, 80) }, 'answered investigation follow-up');
    return {
      intent: 'investigate',
      navigate: `/investigations/${investigationId}`,
      replyContent: reply,
      assistantMessageId: randomUUID(),
      sessionId: sessionId ?? investigation.sessionId,
    };
  }
}
