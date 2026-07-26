import type {
  DashboardAction,
  DashboardSseEvent,
  Identity,
  IFolderRepository,
  InvestigationReportSection,
  NewAuditLogEntry,
  Provenance,
} from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { AdapterRegistry, IWebSearchAdapter } from '../adapters/index.js';
import type { ActionExecutor } from './action-executor.js';
import type { AgentEvent } from './agent-events.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
import type {
  ConnectorConfig,
  OpsCommandRunner,
  OpsConnectorConfig,
  ApprovalRequestStore,
  IDashboardAgentStore,
  IAlertRuleStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
  RemediationPlanStore,
  AgentConfigService,
} from './types.js';
import type { IAccessControlService } from './types-permissions.js';
import type { IPanelEventRepository } from './panel-event-recorder.js';
import type { IPendingChangeRepository } from '@agentic-obs/data-layer';
import type { InvestigationWorkingState } from './investigation-state.js';

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
  allConnectors?: ConnectorConfig[];
  /** Per-session connector pins; chat-service owns the lifecycle. */
  sessionConnectorPins?: Record<string, string>;
  opsCommandRunner?: OpsCommandRunner;
  opsConnectors?: OpsConnectorConfig[];
  /** GitHub VCS read surface for the four `github_*` tools. */
  githubToolRunner?: import('./agent-types.js').GithubToolRunner;
  /** P4 — when present, registers `remediation_plan.create` + `.create_rescue` tools. */
  remediationPlans?: RemediationPlanStore;
  /** P4 — used to auto-emit a plan-level ApprovalRequest on plan creation. */
  approvalRequests?: ApprovalRequestStore;
  /** Connector-model setup and allowlisted settings tools. */
  configService?: AgentConfigService;
  /** Panel-event repository — agent dashboard mutations fire rows via this. */
  panelEvents?: IPanelEventRepository;
  /** Pending-change repository — agent mutation proposals persist here. */
  pendingChanges?: IPendingChangeRepository;
  /** Knowledge-base repository — backs kb_search / kb_get / kb_recommend. */
  knowledge?: import('@agentic-obs/data-layer').IKnowledgeRepository;
  sendEvent: (event: DashboardSseEvent) => void;
  identity: Identity;
  accessControl: IAccessControlService;
  /**
   * Slim fire-and-forget audit writer threaded into every handler ctx
   * (see ActionContext.auditWriter). The agent factory bridges
   * `AuditWriter.log` into this slot so resource-mutation handlers
   * (dashboard_create, alert_rule_write, …) actually persist audit rows.
   */
  auditEntryWriter?: (entry: NewAuditLogEntry) => Promise<void>;
  /**
   * Optional lookup for the most recent chat-event of a given kind in this
   * session. Used by metric_explore to inherit timeRange from a prior
   * inline_chart event. Chat-service binds this to the repository.
   */
  recentEventLookup?: (
    kind: string,
  ) => Promise<{ payload: Record<string, unknown>; timestamp: string } | null>;
}

export interface OrchestratorActionRuntime {
  sessionId: string;
  actionExecutor: ActionExecutor;
  emitAgentEvent(event: AgentEvent): void;
  makeAgentEvent(type: AgentEvent['type'], metadata?: Record<string, unknown>): AgentEvent;
  pushConversationAction(action: DashboardAction): void;
  setNavigateTo(path: string): void;
  recordCreatedResource(
    resourceType: 'dashboard' | 'investigation' | 'alert',
    resourceId: string,
  ): void;
  investigationSections: Map<string, InvestigationReportSection[]>;
  investigationProvenance: Map<string, Provenance & { startedAt?: number; reportId?: string }>;
  investigationStates: Map<string, InvestigationWorkingState>;
  investigationReads: Map<string, Array<{ action: string; family: 'metric' | 'log' | 'ops' | 'change'; sourceAnswered: boolean; consumed: boolean }>>;
  pendingDashboardCreates: ActionContext['pendingDashboardCreates'];
  pendingInvestigationCreates: ActionContext['pendingInvestigationCreates'];
  completedInvestigationAliases: ActionContext['completedInvestigationAliases'];
  /**
   * Mutable holder for the session's active investigation id. The agent
   * owns the underlying state; the ctx exposes a getter/setter that reads
   * and writes through this holder so handler mutations survive the
   * `executeAction` boundary.
   */
  activeInvestigationIdRef: { current: string | null };
  /** Same pattern, for the active dashboard id. */
  activeDashboardIdRef: { current: string | null };
  /** Set of dashboard ids created in this session (vs. opened/loaded). */
  freshlyCreatedDashboards: Set<string>;
  dashboardBuildEvidence: ActionContext['dashboardBuildEvidence'];
}

export function buildActionContext(
  deps: OrchestratorActionContextDeps,
  runtime: OrchestratorActionRuntime,
): ActionContext {
  const invRef = runtime.activeInvestigationIdRef;
  const dashRef = runtime.activeDashboardIdRef;
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
    allConnectors: deps.allConnectors,
    sessionConnectorPins: deps.sessionConnectorPins,
    opsCommandRunner: deps.opsCommandRunner,
    opsConnectors: deps.opsConnectors,
    githubToolRunner: deps.githubToolRunner,
    remediationPlans: deps.remediationPlans,
    approvalRequests: deps.approvalRequests,
    configService: deps.configService,
    panelEvents: deps.panelEvents,
    pendingChanges: deps.pendingChanges,
    knowledge: deps.knowledge,
    sendEvent: deps.sendEvent,
    sessionId: runtime.sessionId,
    identity: deps.identity,
    accessControl: deps.accessControl,
    auditWriter: deps.auditEntryWriter,
    recentEventLookup: deps.recentEventLookup,
    actionExecutor: runtime.actionExecutor,
    emitAgentEvent: runtime.emitAgentEvent,
    makeAgentEvent: runtime.makeAgentEvent,
    pushConversationAction: runtime.pushConversationAction,
    setNavigateTo: runtime.setNavigateTo,
    recordCreatedResource: runtime.recordCreatedResource,
    investigationSections: runtime.investigationSections,
    investigationProvenance: runtime.investigationProvenance,
    investigationStates: runtime.investigationStates,
    investigationReads: runtime.investigationReads,
    pendingDashboardCreates: runtime.pendingDashboardCreates,
    pendingInvestigationCreates: runtime.pendingInvestigationCreates,
    completedInvestigationAliases: runtime.completedInvestigationAliases,
    get activeInvestigationId() { return invRef.current; },
    set activeInvestigationId(v: string | null) { invRef.current = v; },
    get activeDashboardId() { return dashRef.current; },
    set activeDashboardId(v: string | null) { dashRef.current = v; },
    freshlyCreatedDashboards: runtime.freshlyCreatedDashboards,
    dashboardBuildEvidence: runtime.dashboardBuildEvidence,
  };
}
