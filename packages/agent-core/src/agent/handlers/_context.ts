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
  IKnowledgeRepository,
  InvestigationReportSection,
  NewAuditLogEntry,
  Provenance,
} from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { AdapterRegistry, IWebSearchAdapter } from '../../adapters/index.js';
import type { AgentEvent } from '../agent-events.js';
import type {
  IDashboardAgentStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  ConnectorConfig,
  OpsCommandRunner,
  OpsConnectorConfig,
  ApprovalRequestStore,
  RemediationPlanStore,
  AgentConfigService,
} from '../types.js';
import type { ActionExecutor } from '../action-executor.js';
import type { GithubToolRunner } from '../agent-types.js';
import type { IAccessControlService } from '../types-permissions.js';
import type { IPanelEventRepository } from '../panel-event-recorder.js';
import type { IPendingChangeRepository } from '@agentic-obs/data-layer';
import type { AuditVerdict } from '../auditor-prompt.js';

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
   * return "unknown connector" observations uniformly.
   */
  adapters: AdapterRegistry;
  webSearchAdapter?: IWebSearchAdapter;
  allConnectors?: ConnectorConfig[];
  /**
   * Mutable per-session "sticky" connector pins keyed by signal type
   * (e.g. `{ prometheus: 'ds-prod' }`). Survives across tool calls within
   * a single chat session — chat-service constructs the bag, hands it to
   * each agent run, and reads it back so subsequent messages see prior
   * pins. Lifetime is process-memory only; gateway restart drops pins
   * (acceptable v1 — re-asking once is a small cost vs. shipping a schema
   * column for a UX nice-to-have).
   */
  sessionConnectorPins?: Record<string, string>;
  opsCommandRunner?: OpsCommandRunner;
  opsConnectors?: OpsConnectorConfig[];
  /**
   * GitHub VCS read surface used by the four `github_*` tools. When
   * present, the agent can list repos / PRs and fetch PR detail + diff via
   * the org's configured GitHub App connector. Optional — when omitted the
   * handlers return a clear "GitHub connector not configured" observation.
   */
  githubToolRunner?: GithubToolRunner;
  /**
   * Remediation plan store. When present, the `remediation_plan_create`
   * and `.create_rescue` tools are registered. Optional so test/in-memory
   * setups can omit; the handlers return a clear "store not available"
   * observation if the agent invokes them anyway.
   */
  remediationPlans?: RemediationPlanStore;
  /**
   * Approval-request store. Required for the primary
   * `remediation_plan_create` tool to auto-emit a plan-level approval.
   * If absent, plans persist in `pending_approval` status but no
   * ApprovalRequest is created (the UI's plans page can still show them).
   */
  approvalRequests?: ApprovalRequestStore;
  /**
   * Connector-model configuration surface used by connector_* and setting_*.
   * Optional while backend workers land /api/connectors.
   */
  configService?: AgentConfigService;
  /**
   * Knowledge-base repository. When wired, the `kb_search` / `kb_get` /
   * `kb_recommend` tools are usable. Optional so test/in-memory setups can
   * omit; handlers return a clear "knowledge base not configured" observation
   * when absent.
   */
  knowledge?: IKnowledgeRepository;
  /**
   * Panel-event repository — when wired, dashboard mutation handlers fire
   * `panel_events` rows (created / edited / deleted) for agent-driven CRUD.
   * Without this slot, the Express route's hook is the only event source and
   * agent-only sessions show empty panel_events. Fire-and-forget; failures
   * are logged but never block the tool result.
   */
  panelEvents?: IPanelEventRepository;
  /**
   * Pending-change repository — when wired, dashboard mutation handlers
   * (modify_panel / add_panels / remove_panels / set_title / add_variable)
   * write a pending_changes row instead of touching the live dashboard.
   * The accept route applies the row's after_json to the dashboard. Without
   * this slot, handlers fall back to the legacy in-store
   * `appendPendingChanges` path so existing tests stay green.
   */
  pendingChanges?: IPendingChangeRepository;
  sendEvent: (event: DashboardSseEvent) => void;
  sessionId: string;

  /**
   * The authenticated principal on whose behalf this handler runs (see §D1).
   * Handlers that list rows post-filter with `accessControl.filterByPermission`;
   * handlers that act on a specific UID rely on the pre-dispatch gate.
   */
  identity: Identity;
  accessControl: IAccessControlService;
  /**
   * Optional fire-and-forget audit log writer. When wired, resource-mutating
   * handlers (alert_rule_write, investigation_create, etc.) emit audit rows
   * via this slim function. Optional so tests / in-memory wirings can omit;
   * production callers in api-gateway pass through `AuditWriter.log`.
   * Failures are the caller's responsibility — handlers must not await this.
   */
  auditWriter?: (entry: NewAuditLogEntry) => Promise<void>;

  /**
   * Optional chat-event lookup — used by `metric_explore` to inherit the
   * prior chart's timeRange on follow-up questions. The fixed interface
   * shape (`findLatestByKind`) avoids pulling the full repository surface
   * into agent-core; chat-service supplies a bound closure.
   */
  recentEventLookup?: (
    kind: string,
  ) => Promise<{ payload: Record<string, unknown>; timestamp: string } | null>;

  actionExecutor: ActionExecutor;

  emitAgentEvent(event: AgentEvent): void;
  makeAgentEvent(type: AgentEvent['type'], metadata?: Record<string, unknown>): AgentEvent;
  pushConversationAction(action: DashboardAction): void;
  setNavigateTo(path: string): void;
  /**
   * Record that this chat session created a resource (dashboard,
   * investigation, alert) so the chat-service can persist a
   * `chat_session_contexts` row with `relation: 'created_from_chat'`.
   *
   * Called once per resource — handlers that produce multiple resources
   * in one turn (e.g. an LLM asks for two dashboards in one message) MUST
   * call this for each one. Previously the only link was `setNavigateTo`,
   * which overwrites; that left every non-last resource without a
   * by-context lookup row and the chat panel rendered blank when the user
   * opened it.
   */
  recordCreatedResource(
    resourceType: 'dashboard' | 'investigation' | 'alert',
    resourceId: string,
  ): void;

  /**
   * Per-session accumulator for investigation report sections. Lives on the
   * orchestrator instance (one map per session) — previously a module-level
   * `Map` in the handlers file, which leaked across sessions if two ran
   * concurrently with reused investigation ids.
   */
  investigationSections: Map<string, InvestigationReportSection[]>;
  /**
   * Per-investigation provenance accumulator. Populated by `investigation_create`
   * (model + runId + start time) and incremented by `investigation_add_section`
   * (toolCalls + evidenceCount). `investigation_complete` finalises latencyMs and
   * persists the row alongside the report. Cost is not tracked here — Task 04's
   * `llm_audit` table is the source of truth and the UI joins by sessionId when
   * it needs cost. Optional shape mirrors `Provenance` so the UI degrades when
   * fields are missing.
   */
  investigationProvenance: Map<string, Provenance & { startedAt?: number; auditorRounds?: number; reportId?: string }>;
  /**
   * Active investigation id for this session. Set by `investigation_create`,
   * cleared by `investigation_complete`. `add_section` and `complete` read
   * from here instead of taking the id as a tool parameter — earlier the
   * LLM would copy the id wrong (truncation) on long multi-turn runs and
   * sections silently attached to a phantom map key.
   *
   * Session-scoped (single ReAct loop is serial) — owner discipline is the
   * same as `investigationSections`.
   */
  activeInvestigationId: string | null;
  /**
   * Active dashboard id for this session. Set by `dashboard_create` /
   * `dashboard_clone`, never auto-cleared (the user may keep mutating the
   * same dashboard for the rest of the conversation). Same truncation
   * footgun as investigation: the multi-turn `dashboard_create` →
   * `dashboard_add_panels` / `dashboard_modify_panel` flow used to require
   * the model to copy a long uuid back through tool params, with periodic
   * silent corruption.
   */
  activeDashboardId: string | null;
  /**
   * Dashboards CREATED in this session (vs. opened/loaded). Initial population
   * of a fresh dashboard applies directly; modifications to dashboards that
   * predate this session go through `pendingChanges` so the user reviews them
   * before the shared dashboard is mutated. See Task 09 / dashboard handlers.
   */
  freshlyCreatedDashboards: Set<string>;
  /**
   * Per-session dashboard build evidence. Read tools write into this, and
   * dashboard_add_panels checks it before mutating so dashboard creation stays
   * read/verify-first instead of relying only on prompt discipline.
   */
  dashboardBuildEvidence: {
    kbConsultCount: number;
    webSearchCount: number;
    metricDiscoveryCount: number;
    validatedQueries: Set<string>;
  };
  /**
   * Spawns an independent read-only auditor over a draft investigation report.
   * Wired by the orchestrator; ABSENT in unit tests — when absent (or it
   * throws), `investigation_complete` skips the audit gate and completes
   * normally (fail-open: an auditor outage must never block a finished
   * investigation). See `auditor-prompt.ts`.
   */
  runAuditor?: (input: { question: string; report: string }) => Promise<{
    verdict: AuditVerdict;
    gap: string;
  }>;
}
