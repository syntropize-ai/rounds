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
    /** Defaults to `'manual'` when unset. See writable-gate.ts. */
    source?: import('@agentic-obs/common').ResourceSource
    provenance?: import('@agentic-obs/common').ResourceProvenance
  }): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard>
  findById(id: string): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard | null | undefined> | null | undefined
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

/** Minimal connector descriptor passed to the orchestrator. */
export interface ConnectorConfig {
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

export interface AgentConnectorSummary {
  id: string;
  type: string;
  name: string;
  category?: string[];
  capabilities: string[];
  status: string;
  defaultFor?: string | null;
  secretMissing?: boolean;
}

export interface AgentConnectorTemplateSummary {
  type: string;
  category: string[];
  capabilities: string[];
  requiredFields: string[];
  credentialRequired: boolean;
}

export interface AgentConnectorCandidate {
  template: string;
  candidate: Record<string, unknown>;
  confidence: number;
  source: string;
}

/**
 * Minimal connector/config surface for the agent's connector_* and setting_*
 * tools.
 *
 * Implemented by api-gateway once the new connector routes land. Until then
 * tests and local harnesses can provide a mock with the same shape. Raw
 * credentials NEVER flow through this surface; connector secrets are captured
 * by the UI/API secret endpoint and referenced only by connector id.
 */
export interface AgentConfigService {
  listConnectors(filter: {
    orgId: string;
    category?: string;
    capability?: string;
    status?: string;
  }): Promise<AgentConnectorSummary[]>;
  listConnectorTemplates(filter: {
    category?: string;
    capability?: string;
  }): Promise<AgentConnectorTemplateSummary[]>;
  detectConnectors(input: {
    orgId: string;
    template?: string;
  }): Promise<AgentConnectorCandidate[]>;
  proposeConnector(input: {
    orgId: string;
    template: string;
    name: string;
    config: Record<string, unknown>;
    scope?: Record<string, unknown> | null;
    isDefault?: boolean;
    actorUserId?: string | null;
  }): Promise<{
    draftId: string;
    needsCredential: boolean;
    capabilityPreview: string[];
  }>;
  applyConnectorDraft(input: {
    orgId: string;
    draftId: string;
    actorUserId?: string | null;
  }): Promise<{ connectorId: string; status: string; capabilities: string[] }>;
  testConnector(connectorId: string, orgId: string): Promise<{
    ok: boolean;
    latencyMs?: number;
    capabilities: string[];
    error?: string;
  }>;

  /** Read/write allowlisted org settings. */
  getSetting(key: string, orgId: string): Promise<string | null>;
  setSetting(
    key: string,
    value: string,
    actor: { orgId: string; userId: string | null },
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
