import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common/logging';
import type { DashboardSseEvent, Identity, InstanceDatasource } from '@agentic-obs/common';

const log = createLogger('dashboard-service');
import type { IGatewayDashboardStore, IConversationStore } from '../repositories/types.js';
import type { IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer';
import { createLlmGateway } from '../routes/llm-factory.js';
import { DashboardOrchestratorAgent as OrchestratorAgent, AdapterRegistry } from '@agentic-obs/agent-core';
import type { IDashboardAlertRuleStore as IAlertRuleStore, IDashboardInvestigationStore as IInvestigationStore } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter, LokiLogsAdapter } from '@agentic-obs/adapters';
import type { AccessControlSurface } from './accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SetupConfigService } from './setup-config-service.js';

/**
 * Convert InstanceDatasource[] to the narrower `DatasourceConfig[]`
 * shape the orchestrator's system-prompt helpers expect. Drops credential
 * fields (they don't belong in a prompt) and converts `null` → undefined.
 */
export function toAgentDatasources(datasources: InstanceDatasource[]): Array<{
  id: string;
  type: string;
  name: string;
  url: string;
  environment?: string;
  cluster?: string;
  label?: string;
  isDefault?: boolean;
}> {
  return datasources.map((d) => ({
    id: d.id,
    type: d.type,
    name: d.name,
    url: d.url,
    ...(d.environment ? { environment: d.environment } : {}),
    ...(d.cluster ? { cluster: d.cluster } : {}),
    ...(d.label ? { label: d.label } : {}),
    isDefault: d.isDefault,
  }));
}

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

export function resolvePrometheusDatasource(datasources: InstanceDatasource[]): PrometheusDatasource | undefined {
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

/** Build HTTP auth headers from an InstanceDatasource's stored credentials. */
export function datasourceHeaders(ds: InstanceDatasource): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ds.username && ds.password) {
    headers.Authorization = `Basic ${Buffer.from(`${ds.username}:${ds.password}`).toString('base64')}`;
  } else if (ds.apiKey) {
    headers.Authorization = `Bearer ${ds.apiKey}`;
  }
  return headers;
}

/**
 * Build an AdapterRegistry from the user's configured datasources.
 *
 * Each recognized datasource type is instantiated with the appropriate
 * backend adapter class and registered under its `id`. Unrecognized types
 * are skipped silently (the setup wizard may let users save types that
 * we don't have an adapter for yet; those just won't be queryable by the
 * agent until an adapter lands).
 */
export function buildAdapterRegistry(datasources: InstanceDatasource[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const ds of datasources) {
    const headers = datasourceHeaders(ds);
    if (ds.type === 'prometheus' || ds.type === 'victoria-metrics') {
      registry.register({
        info: { id: ds.id, name: ds.name, type: ds.type, url: ds.url, signalType: 'metrics', isDefault: ds.isDefault },
        metrics: new PrometheusMetricsAdapter(ds.url, headers),
      });
    } else if (ds.type === 'loki') {
      registry.register({
        info: { id: ds.id, name: ds.name, type: ds.type, url: ds.url, signalType: 'logs', isDefault: ds.isDefault },
        logs: new LokiLogsAdapter(ds.url, headers),
      });
    }
    // elasticsearch / clickhouse / tempo / jaeger / otel: adapters not yet implemented
  }
  return registry;
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
  /** W2 / T2.4 — LLM + datasource reads go through here, not the old flat-file config. */
  setupConfig: SetupConfigService;
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
  private setupConfig: SetupConfigService;

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
    this.setupConfig = deps.setupConfig;
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
    const llm = await this.setupConfig.getLlm();
    if (!llm) {
      throw new Error('LLM not configured - please complete the Setup Wizard first.');
    }
    const datasources = await this.setupConfig.listDatasources();

    // Save user message
    const userMessageId = randomUUID();
    await this.conversationStore.addMessage(dashboardId, {
      id: userMessageId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const gateway = createLlmGateway(llm);
    const model = llm.model;
    const adapters = buildAdapterRegistry(datasources);

    const orchestrator = new OrchestratorAgent({
      gateway,
      model,
      store: this.store,
      conversationStore: this.conversationStore,
      investigationReportStore: this.investigationReportStore,
      investigationStore: this.investigationStore as IInvestigationStore | undefined,
      alertRuleStore: toAlertRuleStore(this.alertRuleStore),
      ...(this.folderRepository ? { folderRepository: this.folderRepository } : {}),
      adapters,
      allDatasources: toAgentDatasources(datasources),
      sendEvent,
      timeRange: timeRange?.start && timeRange?.end
        ? { start: timeRange.start, end: timeRange.end, timezone: timeRange.timezone }
        : undefined,
      identity,
      accessControl: this.accessControl,
      ...(this.auditWriter ? { auditWriter: this.auditWriter } : {}),
      // Single full-capability agent for every chat surface — see the
      // pickAgentTypeFromContext comment in chat-service.ts.
      agentType: 'orchestrator',
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
