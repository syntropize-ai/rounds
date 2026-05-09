import type { PanelConfig, DashboardVariable, PendingDashboardChange } from '@agentic-obs/common'

// -- Injected dependency interfaces for stores consumed by dashboard agents.
// Concrete implementations live in api-gateway (or data-layer); agents depend
// only on these narrow interfaces.

export interface IDashboardAgentStore {
  create?(params: {
    title: string
    description: string
    prompt: string
    userId: string
    datasourceIds: string[]
    useExistingMetrics?: boolean
    folder?: string
    workspaceId?: string
    sessionId?: string
  }): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard>
  findById(id: string): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard | undefined> | undefined
  findAll?(): import('@agentic-obs/common').Dashboard[] | Promise<import('@agentic-obs/common').Dashboard[]>
  update(id: string, patch: Partial<Pick<import('@agentic-obs/common').Dashboard, 'type' | 'title' | 'description' | 'panels' | 'variables' | 'refreshIntervalSec' | 'folder'>>): unknown
  updateStatus?(id: string, status: string, error?: string): unknown
  updatePanels(id: string, panels: PanelConfig[]): unknown
  updateVariables(id: string, variables: DashboardVariable[]): unknown
  /**
   * Queue AI-proposed modifications that need user review before applying.
   * Receives a list to APPEND — implementations should merge with any
   * existing pendingChanges rather than replace. Optional so legacy stores
   * without a pending-changes column degrade to direct apply (the agent
   * handlers fall back accordingly). See Task 09.
   */
  appendPendingChanges?(id: string, changes: PendingDashboardChange[]): unknown
}

/**
 * Conversation history surface consumed by the orchestrator. Always keyed on
 * the chat sessionId — the legacy dashboardId-keyed shape was removed when
 * dashboard_messages went away. Implementations are free to no-op writes if
 * the host (e.g. chat-service) persists messages itself.
 */
export interface IConversationStore {
  addMessage(sessionId: string, msg: import('@agentic-obs/common').DashboardMessage): import('@agentic-obs/common').DashboardMessage | Promise<import('@agentic-obs/common').DashboardMessage>
  getMessages(sessionId: string): import('@agentic-obs/common').DashboardMessage[] | Promise<import('@agentic-obs/common').DashboardMessage[]>
  clearMessages(sessionId: string): void | Promise<void>
  deleteConversation(sessionId: string): void | Promise<void>
}

export interface IInvestigationReportStore {
  save(report: import('@agentic-obs/common').SavedInvestigationReport): void
}

export interface IInvestigationStore {
  create(params: {
    question: string
    sessionId: string
    userId: string
    entity?: string
    timeRange?: { start: string, end: string }
    tenantId?: string
    workspaceId?: string
  }): import('@agentic-obs/common').Investigation | Promise<import('@agentic-obs/common').Investigation>
  findById?(id: string): import('@agentic-obs/common').Investigation | Promise<import('@agentic-obs/common').Investigation | null | undefined> | null | undefined
  findAll?(): import('@agentic-obs/common').Investigation[] | Promise<import('@agentic-obs/common').Investigation[]>
  updateStatus(id: string, status: import('@agentic-obs/common').InvestigationStatus): unknown
  updatePlan(id: string, plan: import('@agentic-obs/common').Investigation['plan']): unknown
  updateResult(id: string, result: {
    hypotheses: import('@agentic-obs/common').Hypothesis[]
    evidence: import('@agentic-obs/common').Evidence[]
    conclusion: import('@agentic-obs/common').ExplanationResult | null
  }): unknown
}

export interface IAlertRuleStore {
  create(data: Record<string, unknown>): { name: string, severity: string, evaluationIntervalSec: number, condition: { query: string, operator: string, threshold: number, forDurationSec: number }, id?: string } | Promise<{ name: string, severity: string, evaluationIntervalSec: number, condition: { query: string, operator: string, threshold: number, forDurationSec: number }, id?: string }>
  update?(id: string, patch: Record<string, unknown>): unknown
  findAll?(): { id: string, name: string, severity: string, condition: { query: string, operator: string, threshold: number, forDurationSec: number } }[] | Promise<{ id: string, name: string, severity: string, condition: { query: string, operator: string, threshold: number, forDurationSec: number } }[]>
  /** Workspace-scoped listing — used by handlers to scope upsert lookups
   *  to the caller's workspace so a rule with a duplicate name in another
   *  workspace doesn't get clobbered. Optional; falls back to findAll. */
  findByWorkspace?(workspaceId: string): { id: string, name: string, severity: string, condition: { query: string, operator: string, threshold: number, forDurationSec: number } }[] | Promise<{ id: string, name: string, severity: string, condition: { query: string, operator: string, threshold: number, forDurationSec: number } }[]>
  findById?(id: string): unknown
  delete?(id: string): unknown
  /** Resolve the folder UID for a rule within an org. Used by handlers
   *  to build folder-scoped RBAC evaluators on modify/delete. */
  getFolderUid?(orgId: string, ruleId: string): string | null | Promise<string | null>
  /** Recent state-change events (firings / resolutions) ordered newest first.
   *  Optional — implementations without persistent history may omit. */
  getHistory?(ruleId: string, limit?: number): unknown[] | Promise<unknown[]>
  getAllHistory?(limit?: number): unknown[] | Promise<unknown[]>
}

/** Minimal datasource descriptor passed to the orchestrator. */
export interface DatasourceConfig {
  id: string
  type: string
  name: string
  url: string
  environment?: string
  cluster?: string
  label?: string
  isDefault?: boolean
}

export type OpsCommandIntent = 'read' | 'propose' | 'execute_approved' | string

export interface OpsConnectorConfig {
  id: string
  name: string
  environment?: string
  namespaces?: string[]
  capabilities?: string[]
}

export interface OpsCommandRunner {
  listConnectors?(): OpsConnectorConfig[] | Promise<OpsConnectorConfig[]>
  runCommand(params: {
    connectorId: string
    command: string
    intent: OpsCommandIntent
    identity: import('@agentic-obs/common').Identity
    sessionId: string
  }): unknown | Promise<unknown>
}

export type RemediationPlanStepKind = 'ops.run_command' | string

export interface NewRemediationPlanStep {
  kind: RemediationPlanStepKind
  commandText: string
  paramsJson: Record<string, unknown>
  dryRunText?: string | null
  riskNote?: string | null
  continueOnError?: boolean
}

export interface AgentRemediationPlan {
  id: string
  orgId: string
  investigationId: string
  rescueForPlanId: string | null
  summary: string
  status: string
  approvalRequestId: string | null
  steps: Array<{ id?: string; ordinal?: number; [key: string]: unknown }>
}

export interface RemediationPlanStore {
  create(input: {
    id?: string
    orgId: string
    investigationId: string
    rescueForPlanId?: string | null
    summary: string
    status?: string
    autoEdit?: boolean
    approvalRequestId?: string | null
    createdBy: string
    expiresAt?: string
    steps: NewRemediationPlanStep[]
  }): AgentRemediationPlan | Promise<AgentRemediationPlan>
  findByIdInOrg(orgId: string, id: string): AgentRemediationPlan | Promise<AgentRemediationPlan | null> | null
  updatePlan(
    orgId: string,
    id: string,
    patch: { status?: string; autoEdit?: boolean; approvalRequestId?: string | null; resolvedAt?: string | null; resolvedBy?: string | null },
  ): AgentRemediationPlan | Promise<AgentRemediationPlan | null> | null
}

export interface ApprovalAction {
  type: string
  targetService: string
  params: Record<string, unknown>
}

export interface ApprovalContext {
  investigationId?: string
  requestedBy: string
  reason: string
  [key: string]: unknown
}

export interface ApprovalRequest {
  id: string
  action: ApprovalAction
  context: ApprovalContext
  status: string
  createdAt: string
  expiresAt: string
}

/**
 * Minimal config-mutation surface the agent uses for AI-first
 * datasource / connector / org-setting configuration tools.
 *
 * Implemented by api-gateway adapting `SetupConfigService` (and ops connector
 * repo) — agent-core stays decoupled from the gateway. Optional on
 * ActionContext so test/in-memory setups can omit; the handlers return a
 * clear "not configured" observation if the agent invokes them anyway.
 *
 * Raw credentials NEVER flow through this surface — adapters only accept an
 * opaque `secretRef` (string id of an externally-stored secret) plus shape
 * config. Connection probes operate on already-persisted records.
 */
export interface AgentConfigService {
  /** Create or update a datasource draft. `id` set ⇒ update, else create. */
  upsertDatasource(input: {
    id?: string;
    orgId: string;
    type: string;
    name: string;
    url: string;
    environment?: string | null;
    cluster?: string | null;
    label?: string | null;
    isDefault?: boolean;
    secretRef?: string | null;
    actorUserId?: string | null;
  }): Promise<{ id: string; type: string; name: string; url: string; secretMissing?: boolean }>;
  /** Probe an already-persisted datasource. */
  testDatasource(id: string, orgId: string): Promise<{ ok: boolean; message: string }>;

  /** Create or update an ops connector draft. `id` set ⇒ update, else create. */
  upsertOpsConnector(input: {
    id?: string;
    orgId: string;
    type: 'kubernetes';
    name: string;
    environment?: string | null;
    secretRef?: string | null;
    allowedNamespaces?: string[];
    capabilities?: string[];
    actorUserId?: string | null;
  }): Promise<{ id: string; name: string; type: string; secretMissing?: boolean }>;
  /** Probe an already-persisted connector. */
  testOpsConnector(id: string, orgId: string): Promise<{ ok: boolean; message: string; status?: string }>;

  /** Read/write low-risk org settings (default folders, etc). */
  getInstanceSetting(key: string): Promise<string | null>;
  setInstanceSetting(
    key: string,
    value: string,
    actor: { userId: string | null },
  ): Promise<void>;
}

export interface ApprovalRequestStore {
  submit(params: {
    action: ApprovalAction;
    context: ApprovalContext;
    ttlMs?: number;
    /**
     * Optional scope tags so multi-team RBAC can narrow visibility per
     * connector / namespace / team. NULL when the plan has no ops step
     * (cluster-wide write) or no team-owning alert rule. See
     * docs/design/approvals-multi-team-scope.md §3.6.
     */
    opsConnectorId?: string | null;
    targetNamespace?: string | null;
    requesterTeamId?: string | null;
  }): ApprovalRequest | Promise<ApprovalRequest>
}
