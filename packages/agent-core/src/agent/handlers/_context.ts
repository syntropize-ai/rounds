/**
 * Shared `ActionContext` type passed to every handler in this folder.
 *
 * Lives outside `orchestrator-action-handlers.ts` (the now-shim file) so
 * per-domain handler files can import it without forming a cycle through
 * the barrel.
 */

import type {
  DashboardAction,
  DashboardSseEvent,
  Identity,
  IFolderRepository,
  InvestigationReportSection,
} from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { AdapterRegistry, IWebSearchAdapter } from '../../adapters/index.js';
import type { AgentEvent } from '../agent-events.js';
import type {
  IDashboardAgentStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  DatasourceConfig,
  OpsCommandRunner,
  OpsConnectorConfig,
} from '../types.js';
import type { ActionExecutor } from '../action-executor.js';
import type { AlertRuleAgent } from '../alert-rule-agent.js';
import type { IAccessControlService } from '../types-permissions.js';
import type {
  IApprovalRequestRepository,
  IRemediationPlanRepository,
} from '@agentic-obs/data-layer';

/** Shared context passed to every action handler. */
export interface ActionContext {
  gateway: LLMGateway;
  model: string;
  store: IDashboardAgentStore;
  investigationReportStore: IInvestigationReportStore;
  investigationStore?: IInvestigationStore;
  alertRuleStore: IAlertRuleStore;
  /** Folder repository — present when the SQLite folder service is wired.
   *  Optional so tests / in-memory setups can omit; folder.* handlers
   *  return a clear "folder backend not configured" observation if absent. */
  folderRepository?: IFolderRepository;
  /**
   * Source-agnostic adapter registry. Required — the orchestrator resolves
   * every metrics/logs/changes call through it by `sourceId`. A session with
   * no backends configured still gets an empty registry so handlers can
   * return "unknown datasource" observations uniformly.
   */
  adapters: AdapterRegistry;
  webSearchAdapter?: IWebSearchAdapter;
  allDatasources?: DatasourceConfig[];
  /**
   * Mutable per-session "sticky" datasource pins keyed by signal type
   * (e.g. `{ prometheus: 'ds-prod' }`). Survives across tool calls within
   * a single chat session — chat-service constructs the bag, hands it to
   * each agent run, and reads it back so subsequent messages see prior
   * pins. Lifetime is process-memory only; gateway restart drops pins
   * (acceptable v1 — re-asking once is a small cost vs. shipping a schema
   * column for a UX nice-to-have).
   */
  sessionDatasourcePins?: Record<string, string>;
  opsCommandRunner?: OpsCommandRunner;
  opsConnectors?: OpsConnectorConfig[];
  /**
   * Remediation plan store. When present, the `remediation_plan_create`
   * and `.create_rescue` tools are registered. Optional so test/in-memory
   * setups can omit; the handlers return a clear "store not available"
   * observation if the agent invokes them anyway.
   */
  remediationPlans?: IRemediationPlanRepository;
  /**
   * Approval-request store. Required for the primary
   * `remediation_plan_create` tool to auto-emit a plan-level approval.
   * If absent, plans persist in `pending_approval` status but no
   * ApprovalRequest is created (the UI's plans page can still show them).
   */
  approvalRequests?: IApprovalRequestRepository;
  sendEvent: (event: DashboardSseEvent) => void;
  sessionId: string;

  /**
   * The authenticated principal on whose behalf this handler runs (see §D1).
   * Handlers that list rows post-filter with `accessControl.filterByPermission`;
   * handlers that act on a specific UID rely on the pre-dispatch gate.
   */
  identity: Identity;
  accessControl: IAccessControlService;

  actionExecutor: ActionExecutor;
  alertRuleAgent: AlertRuleAgent;

  emitAgentEvent(event: AgentEvent): void;
  makeAgentEvent(type: AgentEvent['type'], metadata?: Record<string, unknown>): AgentEvent;
  pushConversationAction(action: DashboardAction): void;
  setNavigateTo(path: string): void;

  /**
   * Per-session accumulator for investigation report sections. Lives on the
   * orchestrator instance (one map per session) — previously a module-level
   * `Map` in the handlers file, which leaked across sessions if two ran
   * concurrently with reused investigation ids.
   */
  investigationSections: Map<string, InvestigationReportSection[]>;
}
