import type {
  DashboardAction,
  DashboardSseEvent,
  Identity,
  IFolderRepository,
  InvestigationReportSection,
} from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { AdapterRegistry, IWebSearchAdapter } from '../adapters/index.js';
import type { ActionExecutor } from './action-executor.js';
import type { AgentEvent } from './agent-events.js';
import type { AlertRuleAgent } from './alert-rule-agent.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
import type {
  DatasourceConfig,
  IDashboardAgentStore,
  IAlertRuleStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
} from './types.js';
import type { IAccessControlService } from './types-permissions.js';

export interface OrchestratorActionContextDeps {
  gateway: LLMGateway;
  model: string;
  store: IDashboardAgentStore;
  conversationStore: IConversationStore;
  investigationReportStore: IInvestigationReportStore;
  investigationStore?: IInvestigationStore;
  alertRuleStore: IAlertRuleStore;
  folderRepository?: IFolderRepository;
  adapters: AdapterRegistry;
  webSearchAdapter?: IWebSearchAdapter;
  allDatasources?: DatasourceConfig[];
  sendEvent: (event: DashboardSseEvent) => void;
  identity: Identity;
  accessControl: IAccessControlService;
}

export interface OrchestratorActionRuntime {
  sessionId: string;
  actionExecutor: ActionExecutor;
  alertRuleAgent: AlertRuleAgent;
  emitAgentEvent(event: AgentEvent): void;
  makeAgentEvent(type: AgentEvent['type'], metadata?: Record<string, unknown>): AgentEvent;
  pushConversationAction(action: DashboardAction): void;
  setNavigateTo(path: string): void;
  investigationSections: Map<string, InvestigationReportSection[]>;
}

export function buildActionContext(
  deps: OrchestratorActionContextDeps,
  runtime: OrchestratorActionRuntime,
): ActionContext {
  return {
    gateway: deps.gateway,
    model: deps.model,
    store: deps.store,
    investigationReportStore: deps.investigationReportStore,
    investigationStore: deps.investigationStore,
    alertRuleStore: deps.alertRuleStore,
    folderRepository: deps.folderRepository,
    adapters: deps.adapters,
    webSearchAdapter: deps.webSearchAdapter,
    allDatasources: deps.allDatasources,
    sendEvent: deps.sendEvent,
    sessionId: runtime.sessionId,
    identity: deps.identity,
    accessControl: deps.accessControl,
    actionExecutor: runtime.actionExecutor,
    alertRuleAgent: runtime.alertRuleAgent,
    emitAgentEvent: runtime.emitAgentEvent,
    makeAgentEvent: runtime.makeAgentEvent,
    pushConversationAction: runtime.pushConversationAction,
    setNavigateTo: runtime.setNavigateTo,
    investigationSections: runtime.investigationSections,
  };
}
