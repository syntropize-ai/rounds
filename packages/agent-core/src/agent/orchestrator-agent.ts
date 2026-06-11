import { randomUUID } from 'node:crypto'
import { getErrorMessage } from '@agentic-obs/common'
import { createLogger } from '@agentic-obs/server-utils/logging'
import type {
  DashboardSseEvent,
  DashboardAction,
  Identity,
  IFolderRepository,
  InvestigationReportSection,
  NewAuditLogEntry,
  Provenance,
} from '@agentic-obs/common'
import type {
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  ConnectorConfig,
  OpsCommandRunner,
  OpsConnectorConfig,
  ApprovalRequestStore,
  RemediationPlanStore,
  AgentConfigService,
} from './types.js'
import type { AdapterRegistry, IWebSearchAdapter } from '../adapters/index.js'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { ActionExecutor } from './action-executor.js'
import { ReActLoop } from './react-loop.js'
import type { ReActStep } from './react-loop.js'
import { agentRegistry } from './agent-registry.js'
import type { AgentDefinition } from './agent-definition.js'
import type { AgentType } from './agent-types.js'
import type { AgentEvent } from './agent-events.js'
import type {
  IAccessControlService,
  IAuditWriter,
} from './types-permissions.js'
import type { AlertRuleSummary } from './orchestrator-alert-helpers.js'
import { createInvestigationWorkingState, type InvestigationWorkingState } from './investigation-state.js'
import {
  getStructuredAlertRuleContext,
  parseAlertFollowUpAction,
  composeAlertFollowUpReply,
} from './orchestrator-alert-helpers.js'
import { buildSystemPrompt } from './orchestrator-prompt.js'
import { buildActionContext } from './orchestrator-action-context.js'
import { ToolAuditReporter } from './orchestrator-audit-reporter.js'
import { PermissionWrappedActionRunner } from './orchestrator-action-runner.js'

export interface OrchestratorDeps {
  gateway: LLMGateway
  model: string
  store: IDashboardAgentStore
  conversationStore: IConversationStore
  investigationReportStore: IInvestigationReportStore
  investigationStore?: IInvestigationStore
  alertRuleStore: IAlertRuleStore
  /** Folder backend for agent folder.* tools. Optional — omitted in pure
   *  in-memory deployments; folder.* tools return a clear "not configured"
   *  observation if absent. */
  folderRepository?: IFolderRepository
  /**
   * Source-agnostic adapter registry — the orchestrator dispatches every
   * metrics/logs/changes tool through this. Required; pass an empty
   * `new AdapterRegistry()` if no backends are wired (all handlers will
   * return a uniform "unknown connector" observation).
   */
  adapters: AdapterRegistry
  webSearchAdapter?: IWebSearchAdapter
  allConnectors?: ConnectorConfig[]
  /** Live per-session connector pin bag (see chat-service for lifecycle). */
  sessionConnectorPins?: Record<string, string>
  opsCommandRunner?: OpsCommandRunner
  opsConnectors?: OpsConnectorConfig[]
  /** GitHub VCS read surface. Wired by chat-service when both connectorRepo
   *  and githubAppTokenService are available; agent-core depends on the
   *  interface only. */
  githubToolRunner?: import('./agent-types.js').GithubToolRunner
  /** P4 — when present, registers remediation_plan.create + .create_rescue tools. */
  remediationPlans?: RemediationPlanStore
  /** P4 — used to auto-emit a plan-level ApprovalRequest on plan creation. */
  approvalRequests?: ApprovalRequestStore
  /** Task 07 — AI-first configuration tools (connector / settings). */
  configService?: AgentConfigService
  /**
   * Panel-event repository — when wired, agent dashboard mutations fire
   * panel_events rows. Optional; the Express dashboard route still has its
   * own hook for non-agent CRUD.
   */
  panelEvents?: import('./panel-event-recorder.js').IPanelEventRepository
  /**
   * Pending-change repository — when wired, dashboard mutation handlers
   * persist agent proposals here instead of touching the live dashboard.
   * Optional; legacy in-store appendPendingChanges path stays as fallback.
   */
  pendingChanges?: import('@agentic-obs/data-layer').IPendingChangeRepository
  /**
   * Knowledge-base repository — wired so the kb_search / kb_get / kb_recommend
   * handlers can hit the bundled + saved entries. When absent the handlers
   * short-circuit with a "knowledge base not configured" observation; the
   * agent typically interprets that as "no KB available, fall through to
   * web_search" which is exactly the bug we hit when the dep didn't reach
   * here.
   */
  knowledge?: import('@agentic-obs/data-layer').IKnowledgeRepository
  sendEvent: (event: DashboardSseEvent) => void
  pageContext?: { kind: string; id?: string }
  timeRange?: { start: string; end: string; clientTimezone?: string }
  maxTokenBudget?: number
  /** LLM-generated summary of earlier conversation turns (from context compaction) */
  conversationSummary?: string
  /**
   * Wave 7 — the caller's bound identity. Required. The agent is the user's
   * hands; running without one is undefined by design (see §D1, §D4).
   */
  identity: Identity
  /** Access-control surface for the per-call gate and list-filter. */
  accessControl: IAccessControlService
  /**
   * Audit-log writer. Optional (tests can omit) but production callers MUST
   * pass one — every gated dispatch writes `agent.tool_called` or
   * `agent.tool_denied` per §D9.
   */
  auditWriter?: IAuditWriter
  /**
   * Slim fire-and-forget audit writer for resource-mutation handlers
   * (`dashboard_create`, `alert_rule_write`, …). The agent factory bridges
   * `AuditWriter.log` into this slot so handler audit rows actually persist
   * — without it, `ctx.auditWriter?.(entry)` is a no-op.
   */
  auditEntryWriter?: (entry: NewAuditLogEntry) => Promise<void>
  /**
   * Optional chat-event lookup (most-recent by kind in this session).
   * Wired by chat-service from the chat-session-event repository so
   * `metric_explore` can inherit timeRange from a prior `inline_chart`.
   */
  recentEventLookup?: (
    kind: string,
  ) => Promise<{ payload: Record<string, unknown>; timestamp: string } | null>
  /**
   * Which specialized agent this run uses. Defaults to `orchestrator`. Pick a
   * narrower type to tighten the allowedTools ceiling (Layer 1).
   */
  agentType?: AgentType
  /**
   * Operator-configured escalation contact displayed to the LLM as a factual
   * template variable. See §D8, §D13. Falls back to process.env when unset.
   */
  permissionEscalationContact?: string
}

const log = createLogger('orchestrator')

export class OrchestratorAgent {
  static readonly definition = agentRegistry.get('orchestrator')!;

  private readonly actionExecutor: ActionExecutor
  private readonly reactLoop: ReActLoop
  private readonly agentDef: AgentDefinition
  private readonly auditReporter: ToolAuditReporter
  private readonly actionRunner: PermissionWrappedActionRunner
  private pendingConversationActions: DashboardAction[] = []
  private pendingNavigateTo?: string
  /**
   * Resources the agent created during the current turn. Recorded by
   * handlers via `ctx.recordCreatedResource` and drained by the
   * chat-service after the turn finishes so EVERY new dashboard /
   * investigation / alert gets a `chat_session_contexts` row — not just
   * whichever happened to win the `setNavigateTo` race.
   */
  private pendingCreatedResources: Array<{
    resourceType: 'dashboard' | 'investigation' | 'alert';
    resourceId: string;
  }> = []
  /**
   * Per-session accumulator for investigation report sections. Lives on the
   * agent instance (not module-level) so concurrent sessions cannot leak
   * sections into each other when investigation ids collide.
   */
  private readonly investigationSections = new Map<string, InvestigationReportSection[]>()
  /** Per-investigation provenance accumulator (Task 10). See ActionContext docs. */
  private readonly investigationProvenance = new Map<string, Provenance & {
    startedAt?: number;
    reportId?: string;
    readToolCalls?: number;
    metricReadCalls?: number;
    logReadCalls?: number;
    opsReadCalls?: number;
    changeReadCalls?: number;
  }>()
  private readonly investigationStates = new Map<string, InvestigationWorkingState>()
  private readonly pendingDashboardCreates = new Map<string, import('./handlers/_context.js').PendingDashboardCreate>()
  private readonly pendingInvestigationCreates = new Map<string, import('./handlers/_context.js').PendingInvestigationCreate>()
  private readonly completedInvestigationAliases = new Map<string, string>()
  /**
   * Active investigation id for this session. Implicit context for
   * investigation_add_section / investigation_complete so the LLM doesn't
   * have to round-trip the id through tool params. Held in a ref so the
   * action ctx (built fresh each step) can read/write the same slot.
   */
  private readonly activeInvestigationIdRef: { current: string | null } = { current: null }
  /** Same pattern for the active dashboard id (set by dashboard_create / _clone). */
  private readonly activeDashboardIdRef: { current: string | null } = { current: null }
  /** Task 09 — dashboards created in this session apply mutations directly;
   *  pre-existing dashboards funnel modifications through pendingChanges. */
  private readonly freshlyCreatedDashboards: Set<string> = new Set()
  private readonly dashboardBuildEvidence = {
    kbConsultCount: 0,
    webSearchCount: 0,
    metricDiscoveryCount: 0,
    validatedQueries: new Set<string>(),
  }
  private investigationDirtyThisTurn = false
  readonly sessionId: string

  constructor(private deps: OrchestratorDeps, sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID()
    this.actionExecutor = new ActionExecutor(deps.store, deps.sendEvent)

    const type = deps.agentType ?? 'orchestrator'
    const def = agentRegistry.get(type)
    if (!def) {
      throw new Error(`OrchestratorAgent: unknown agent type "${type}"`)
    }
    this.agentDef = def
    this.auditReporter = new ToolAuditReporter({
      identity: deps.identity,
      auditWriter: deps.auditWriter,
      agentDef: this.agentDef,
    })
    this.actionRunner = new PermissionWrappedActionRunner({
      agentDef: this.agentDef,
      auditReporter: this.auditReporter,
      sendEvent: deps.sendEvent,
      emitAgentEvent: (event) => this.emitAgentEvent(event),
      makeAgentEvent: (eventType, metadata) => this.makeAgentEvent(eventType, metadata),
    })

    const metricsSources = deps.adapters.list({ signalType: 'metrics' })

    this.reactLoop = new ReActLoop({
      gateway: deps.gateway,
      model: deps.model,
      sendEvent: deps.sendEvent,
      identity: deps.identity,
      accessControl: deps.accessControl,
      allowedTools: this.agentDef.allowedTools,
      maxIterations: this.agentDef.maxIterations,
      maxTokenBudget: deps.maxTokenBudget,
      conversationSummary: deps.conversationSummary,
      onBeforeTerminate: (finalText) => this.onBeforeTerminate(finalText),
    })

    log.info(`[Orchestrator] init: agentType=${type}, metricsSources=${metricsSources.length}`)
  }

  private emitAgentEvent(event: AgentEvent): void {
    this.deps.sendEvent({ type: 'agent_event', event });
  }

  private makeAgentEvent(
    type: AgentEvent['type'],
    metadata?: Record<string, unknown>,
  ): AgentEvent {
    return {
      type,
      agentType: this.agentDef.type,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
  }

  consumeConversationActions(): DashboardAction[] {
    const actions = [...this.pendingConversationActions]
    this.pendingConversationActions = []
    return actions
  }

  consumeNavigate(): string | undefined {
    const navigateTo = this.pendingNavigateTo
    this.pendingNavigateTo = undefined
    return navigateTo
  }

  consumeCreatedResources(): Array<{
    resourceType: 'dashboard' | 'investigation' | 'alert';
    resourceId: string;
  }> {
    const out = [...this.pendingCreatedResources]
    this.pendingCreatedResources = []
    return out
  }

  /**
   * Handle a user message. When dashboardId is provided, the agent is scoped
   * to that dashboard (backward compat). When omitted, the agent operates in
   * session mode — it can create dashboards/investigations via tools.
   *
   * `signal` is plumbed from the HTTP layer — when the SSE client disconnects
   * the chat router triggers it, and the loop / gateway / provider fetches
   * abort instead of running expensive LLM calls to completion against a
   * closed socket.
   */
  async handleMessage(
    message: string,
    dashboardId?: string,
    signal?: AbortSignal,
    opts?: { reopenInvestigationId?: string },
  ): Promise<string> {
    this.emitAgentEvent(this.makeAgentEvent('agent.started', { dashboardId, message }));
    this.pendingConversationActions = []
    this.pendingNavigateTo = undefined
    this.pendingCreatedResources = []
    this.investigationDirtyThisTurn = false

    // Resolve dashboard context (optional in session mode)
    const dashboard = dashboardId
      ? await this.deps.store.findById(dashboardId)
      : undefined
    if (dashboardId && !dashboard) {
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', { reason: 'Dashboard not found' }));
      throw new Error(`Dashboard ${dashboardId} not found`)
    }
    // Pin the page-context dashboard as the active target so dashboard.*
    // mutation tools can drop the dashboardId parameter. The model never
    // had to copy long uuids back through tool params on the truncation
    // path that motivated this design — see _context.ts.
    if (dashboard) {
      this.activeDashboardIdRef.current = dashboard.id
    }

    // Conversation history is keyed on the chat session, not the dashboard.
    // The chat-service writes every user/assistant turn into chat_messages
    // by sessionId; the legacy dashboard_messages table is no longer the
    // source of truth. Reading by dashboardId here would return an empty
    // (or stale) history and the model would lose all context for follow-up
    // turns inside an open dashboard.
    const conversationKey = this.sessionId
    const history = await this.deps.conversationStore.getMessages(conversationKey)

    // Fetch existing alert rules so LLM can reference them for modify/delete.
    // Context-loading failure is degraded UX (model gets no rule list) but is
    // safe — log + continue with an empty list so the user gets a working
    // (if narrower) chat instead of a 500.
    let alertRules: AlertRuleSummary[] = []
    if (this.deps.alertRuleStore.findAll) {
      try {
        const result = await this.deps.alertRuleStore.findAll()
        alertRules = (Array.isArray(result) ? result : (result as { list: unknown[] }).list ?? []) as typeof alertRules
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), dashboardId, sessionId: this.sessionId },
          'orchestrator: alertRuleStore.findAll failed — proceeding with empty list',
        )
      }
    }

    const activeAlertRule = getStructuredAlertRuleContext(history, alertRules)
    const directFollowUpAction = parseAlertFollowUpAction(message, activeAlertRule)
    if (directFollowUpAction) {
      const result = await this.executeAction(directFollowUpAction)
      const finalReply = result
        ? await composeAlertFollowUpReply(this.deps.gateway, this.deps.model, message, directFollowUpAction, result)
        : ''
      if (finalReply) {
        this.deps.sendEvent({ type: 'reply', content: finalReply })
      }
      this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId, mode: 'structured_alert_followup' }));
      return finalReply
    }

    // Reopen path: a follow-up that landed inside an existing investigation
    // rehydrates that investigation's report so the loop CONTINUES it (updates
    // the same on-screen report) instead of starting a new one. Skipped when
    // an investigation is already active in this session.
    let reopenedSectionCount: number | null = null
    if (opts?.reopenInvestigationId && this.activeInvestigationIdRef.current === null) {
      reopenedSectionCount = await this.reopenInvestigation(opts.reopenInvestigationId)
    }

    const hasMetrics = this.deps.adapters.list({ signalType: 'metrics' }).length > 0
    const systemPrompt = buildSystemPrompt(dashboard ?? null, history, alertRules, activeAlertRule, this.deps.allConnectors ?? [], {
      hasPrometheus: hasMetrics,
      timeRange: this.deps.timeRange ? { start: this.deps.timeRange.start, end: this.deps.timeRange.end } : undefined,
      identity: this.deps.identity,
      permissionEscalationContact: this.deps.permissionEscalationContact,
      opsConnectors: this.deps.opsConnectors,
      allowedTools: this.agentDef.allowedTools,
      agentType: this.agentDef.type,
      pageContext: this.deps.pageContext,
    })
    const finalSystemPrompt = reopenedSectionCount !== null
      ? `${systemPrompt}\n\n${buildReopenAddendum(reopenedSectionCount)}`
      : systemPrompt

    try {
      const result = await this.reactLoop.runLoop(
        finalSystemPrompt,
        message,
        (step) => this.executeAction(step, message),
        signal,
      )
      this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId }));
      return result;
    }
    catch (err) {
      // Distinguish "client cancelled" (expected) from "agent crashed".
      const isAbort = err instanceof Error && err.name === 'AbortError'
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', {
        dashboardId,
        error: getErrorMessage(err),
        ...(isAbort ? { reason: 'aborted' } : {}),
      }));
      throw err;
    }
  }

  /**
   * Rehydrate a completed (or in-flight) investigation so the loop can keep
   * digging and UPDATE the same report. Seeds the section + provenance
   * accumulators from the latest persisted report and re-activates the id.
   * Returns the rehydrated section count, or null when there's nothing to
   * reopen (no read surface, not owned by this workspace, or no prior report —
   * in which case the follow-up just behaves as a fresh request).
   */
  private async reopenInvestigation(investigationId: string): Promise<number | null> {
    const store = this.deps.investigationReportStore
    if (!store.findByDashboard) return null
    // Ownership gate: never rehydrate a report the caller doesn't own.
    if (this.deps.investigationStore?.findById) {
      const inv = await this.deps.investigationStore.findById(investigationId)
      if (!inv || inv.workspaceId !== this.deps.identity.orgId) return null
    }
    const reports = await store.findByDashboard(investigationId)
    const latest = reports[reports.length - 1]
    if (!latest) return null
    // Reuse the report's id (reportId) so investigation_complete upserts THIS
    // row in place rather than inserting a duplicate. startedAt is reset — the
    // continuation's latency is measured from now.
    this.investigationSections.set(investigationId, [...latest.sections])
    this.investigationProvenance.set(investigationId, {
      ...(latest.provenance ?? {}),
      startedAt: Date.now(),
      reportId: latest.id,
    })
    this.investigationStates.set(investigationId, createInvestigationWorkingState())
    this.activeInvestigationIdRef.current = investigationId
    log.info({ investigationId, sections: latest.sections.length, sessionId: this.sessionId }, 'reopened investigation for follow-up')
    return latest.sections.length
  }

  private async executeAction(
    step: ReActStep,
    _userMessage = '',
  ): Promise<string | null> {
    const ctx = buildActionContext(this.deps, {
      sessionId: this.sessionId,
      actionExecutor: this.actionExecutor,
      emitAgentEvent: (event) => this.emitAgentEvent(event),
      makeAgentEvent: (type, metadata) => this.makeAgentEvent(type, metadata),
      pushConversationAction: (action) => this.pendingConversationActions.push(action),
      setNavigateTo: (path) => { this.pendingNavigateTo = path },
      recordCreatedResource: (resourceType, resourceId) => {
        this.pendingCreatedResources.push({ resourceType, resourceId });
      },
      investigationSections: this.investigationSections,
      investigationProvenance: this.investigationProvenance,
      investigationStates: this.investigationStates,
      pendingDashboardCreates: this.pendingDashboardCreates,
      pendingInvestigationCreates: this.pendingInvestigationCreates,
      completedInvestigationAliases: this.completedInvestigationAliases,
      activeInvestigationIdRef: this.activeInvestigationIdRef,
      activeDashboardIdRef: this.activeDashboardIdRef,
      freshlyCreatedDashboards: this.freshlyCreatedDashboards,
      dashboardBuildEvidence: this.dashboardBuildEvidence,
    })
    let result = await this.actionRunner.execute(step, ctx)
    if (result !== null) {
      if (this.recordInvestigationRead(step.action)) {
        result += '\n\n<system-reminder>For this investigation, record the diagnostic meaning of the read you just performed with investigation_record_check before moving to the next major check. Ignore this only if the read was irrelevant noise.</system-reminder>'
      }
    }
    if (result !== null && INVESTIGATION_DIRTY_ACTIONS.has(step.action)) {
      this.investigationDirtyThisTurn = true
    }
    return result
  }

  private recordInvestigationRead(action: string): boolean {
    const investigationId = this.activeInvestigationIdRef.current
    if (!investigationId || !INVESTIGATION_READ_ACTIONS.has(action)) return false
    const prov = this.investigationProvenance.get(investigationId)
    if (!prov) return false
    prov.readToolCalls = (prov.readToolCalls ?? 0) + 1
    if (action.startsWith('metrics_')) {
      prov.metricReadCalls = (prov.metricReadCalls ?? 0) + 1
    } else if (action.startsWith('logs_')) {
      prov.logReadCalls = (prov.logReadCalls ?? 0) + 1
    } else if (action === 'ops_run_command') {
      prov.opsReadCalls = (prov.opsReadCalls ?? 0) + 1
    } else if (action === 'changes_list_recent') {
      prov.changeReadCalls = (prov.changeReadCalls ?? 0) + 1
    }
    return true
  }

  private onBeforeTerminate(_finalText: string): string | null {
    if (!this.investigationDirtyThisTurn || !this.activeInvestigationIdRef.current) return null
    return 'You created or updated an investigation but have not called investigation_complete. That conclusion is not recorded yet. Add the remaining checks, call investigation_record_check for each load-bearing diagnostic read, then call investigation_complete with a structured rootCause and confidence. This turn must end through investigation_complete, not plain text.'
  }
}

/**
 * Appended to the system prompt when a follow-up reopens an existing
 * investigation. Stops the model from spinning up a NEW investigation and
 * tells it the prior report is already loaded and will be updated in place.
 */
function buildReopenAddendum(sectionCount: number): string {
  return `# Continuing an existing investigation
This follow-up is on an investigation that already has a saved report (${sectionCount} section${sectionCount === 1 ? '' : 's'} already loaded into your working set, and it is already the active investigation). Do NOT call \`investigation_create\` — that would start a separate investigation. Build on what's there: pick up the trail (especially any "## Unresolved" gap), add NEW \`investigation_add_text\` / \`investigation_add_evidence\` sections for what you find, and call \`investigation_complete\` to UPDATE the same report. Don't restate sections that already exist.`
}

const INVESTIGATION_DIRTY_ACTIONS: ReadonlySet<string> = new Set([
  'investigation_create',
  'investigation_record_check',
  'investigation_add_text',
  'investigation_add_evidence',
])

const INVESTIGATION_READ_ACTIONS: ReadonlySet<string> = new Set([
  'metrics_query',
  'metrics_range_query',
  'metrics_discover',
  'metrics_validate',
  'metrics_list_names',
  'metrics_get_labels',
  'metrics_get_label_values',
  'metrics_get_cardinality',
  'metrics_sample_series',
  'metrics_find_related',
  'logs_query',
  'logs_labels',
  'logs_label_values',
  'ops_run_command',
  'changes_list_recent',
  'github_list_repos',
  'github_list_prs',
  'github_get_pr',
  'github_get_diff',
  'kb_search',
  'kb_get',
  'kb_recommend',
  'web_search',
])
