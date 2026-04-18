import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';
import type { DashboardSseEvent, Identity } from '@agentic-obs/common';

const log = createLogger('dashboard-service');
import type { IGatewayDashboardStore, IConversationStore } from '../repositories/types.js';
import type { IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer';
import { getSetupConfig, type DatasourceConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';
import { DashboardOrchestratorAgent as OrchestratorAgent } from '@agentic-obs/agent-core';
import type { IDashboardAlertRuleStore as IAlertRuleStore, IDashboardInvestigationStore as IInvestigationStore } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import type { AccessControlSurface } from './accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';

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
  navigate?: string;
}

export interface ChatTimeRange {
  start?: string;
  end?: string;
  timezone?: string;
}

export interface DashboardServiceDeps {
  store: IGatewayDashboardStore;
  conversationStore: IConversationStore;
  investigationReportStore: IInvestigationReportRepository;
  alertRuleStore: IAlertRuleRepository;
  investigationStore?: IGatewayInvestigationStore;
  feedStore?: IGatewayFeedStore;
  /** Wave 7 — RBAC surface for the agent permission gate. Required. */
  accessControl: AccessControlSurface;
  /** Audit-log writer. */
  auditWriter?: AuditWriter;
  /** Folder backend for agent folder.* tools; optional. */
  folderRepository?: import('@agentic-obs/common').IFolderRepository;
}

export class DashboardService {
  private store: IGatewayDashboardStore;
  private conversationStore: IConversationStore;
  private investigationReportStore: IInvestigationReportRepository;
  private alertRuleStore: IAlertRuleRepository;
  private investigationStore?: IGatewayInvestigationStore;
  private feedStore?: IGatewayFeedStore;
  private accessControl: AccessControlSurface;
  private auditWriter?: AuditWriter;
  private folderRepository?: import('@agentic-obs/common').IFolderRepository;

  constructor(deps: DashboardServiceDeps) {
    this.store = deps.store;
    this.conversationStore = deps.conversationStore;
    this.investigationReportStore = deps.investigationReportStore;
    this.investigationStore = deps.investigationStore;
    this.feedStore = deps.feedStore;
    this.alertRuleStore = deps.alertRuleStore;
    this.accessControl = deps.accessControl;
    this.auditWriter = deps.auditWriter;
    this.folderRepository = deps.folderRepository;
  }

  /**
   * Process a chat message for a dashboard.
   * Business logic only — no HTTP/SSE concerns.
   */
  async handleChatMessage(
    dashboardId: string,
    message: string,
    timeRange: ChatTimeRange | undefined,
    sendEvent: (event: DashboardSseEvent) => void,
    identity: Identity,
  ): Promise<ChatResult> {
    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured - please complete the Setup Wizard first.');
    }

    // Save user message
    const userMessageId = randomUUID();
    await this.conversationStore.addMessage(dashboardId, {
      id: userMessageId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model;
    const prom = resolvePrometheusDatasource(config.datasources);

    const metricsAdapter = prom
      ? new PrometheusMetricsAdapter(prom.url, prom.headers)
      : undefined;

    const orchestrator = new OrchestratorAgent({
      gateway,
      model,
      store: this.store,
      conversationStore: this.conversationStore,
      investigationReportStore: this.investigationReportStore,
      investigationStore: this.investigationStore as IInvestigationStore | undefined,
      alertRuleStore: toAlertRuleStore(this.alertRuleStore),
      ...(this.folderRepository ? { folderRepository: this.folderRepository } : {}),
      metricsAdapter,
      allDatasources: config.datasources,
      sendEvent,
      timeRange: timeRange?.start && timeRange?.end
        ? { start: timeRange.start, end: timeRange.end, timezone: timeRange.timezone }
        : undefined,
      identity,
      accessControl: this.accessControl,
      ...(this.auditWriter ? { auditWriter: this.auditWriter } : {}),
      // Dashboard-scoped chat → dashboard-assistant ceiling (no alert / user /
      // team management from a dashboard chat panel, even for admins).
      agentType: 'dashboard-assistant',
    });

    log.info({ dashboardId, message: message.slice(0, 80) }, 'starting orchestrator');
    const replyContent = await orchestrator.handleMessage(message, dashboardId);
    const assistantActions = orchestrator.consumeConversationActions();
    const navigate = orchestrator.consumeNavigate();
    log.info({ dashboardId, reply: replyContent.slice(0, 100) }, 'orchestrator done');

    // Mark dashboard as ready (stops frontend polling)
    await this.store.updateStatus(dashboardId, 'ready');

    // Save assistant message
    const assistantMessageId = randomUUID();
    await this.conversationStore.addMessage(dashboardId, {
      id: assistantMessageId,
      role: 'assistant',
      content: replyContent,
      ...(assistantActions.length > 0 ? { actions: assistantActions } : {}),
      timestamp: new Date().toISOString(),
    });

    return { replyContent, assistantMessageId, navigate };
  }
}
