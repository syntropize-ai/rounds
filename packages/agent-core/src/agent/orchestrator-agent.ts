import { randomUUID } from 'node:crypto'
import { getErrorMessage } from '@agentic-obs/common'
import { createLogger } from '@agentic-obs/common/logging'
import type {
  DashboardSseEvent,
  DashboardAction,
  Identity,
  IFolderRepository,
  InvestigationReportSection,
} from '@agentic-obs/common'
import type {
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  DatasourceConfig,
  OpsCommandRunner,
  OpsConnectorConfig,
  ApprovalRequestStore,
  RemediationPlanStore,
} from './types.js'
import type { AdapterRegistry, IWebSearchAdapter } from '../adapters/index.js'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { ActionExecutor } from './action-executor.js'
import { AlertRuleAgent } from './alert-rule-agent.js'
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
   * return a uniform "unknown datasource" observation).
   */
  adapters: AdapterRegistry
  webSearchAdapter?: IWebSearchAdapter
  allDatasources?: DatasourceConfig[]
  /** Live per-session datasource pin bag (see chat-service for lifecycle). */
  sessionDatasourcePins?: Record<string, string>
  opsCommandRunner?: OpsCommandRunner
  opsConnectors?: OpsConnectorConfig[]
  /** P4 — when present, registers remediation_plan.create + .create_rescue tools. */
  remediationPlans?: RemediationPlanStore
  /** P4 — used to auto-emit a plan-level ApprovalRequest on plan creation. */
  approvalRequests?: ApprovalRequestStore
  sendEvent: (event: DashboardSseEvent) => void
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
  private readonly alertRuleAgent: AlertRuleAgent
  private readonly reactLoop: ReActLoop
  private readonly agentDef: AgentDefinition
  private readonly auditReporter: ToolAuditReporter
  private readonly actionRunner: PermissionWrappedActionRunner
  private pendingConversationActions: DashboardAction[] = []
  private pendingNavigateTo?: string
  /**
   * Per-session accumulator for investigation report sections. Lives on the
   * agent instance (not module-level) so concurrent sessions cannot leak
   * sections into each other when investigation ids collide.
   */
  private readonly investigationSections = new Map<string, InvestigationReportSection[]>()
  /**
   * Active investigation id for this session. Implicit context for
   * investigation_add_section / investigation_complete so the LLM doesn't
   * have to round-trip the id through tool params. Held in a ref so the
   * action ctx (built fresh each step) can read/write the same slot.
   */
  private readonly activeInvestigationIdRef: { current: string | null } = { current: null }
  /** Same pattern for the active dashboard id (set by dashboard_create / _clone). */
  private readonly activeDashboardIdRef: { current: string | null } = { current: null }
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

    // AlertRuleAgent still needs a single metrics adapter for its PromQL
    // grounding / validation step. Pick the default metrics source (or the
    // first one registered) — the generator is a helper scoped to one
    // backend per call, not a multi-source tool.
    const metricsSources = deps.adapters.list({ signalType: 'metrics' })
    const defaultMetricsSource = metricsSources.find((d) => d.isDefault) ?? metricsSources[0]
    const metricsForAlertRule = defaultMetricsSource
      ? deps.adapters.metrics(defaultMetricsSource.id)
      : undefined

    this.alertRuleAgent = new AlertRuleAgent({
      gateway: deps.gateway,
      model: deps.model,
      metrics: metricsForAlertRule,
    })

    this.reactLoop = new ReActLoop({
      gateway: deps.gateway,
      model: deps.model,
      sendEvent: deps.sendEvent,
      identity: deps.identity,
      accessControl: deps.accessControl,
      allowedTools: this.agentDef.allowedTools,
      maxTokenBudget: deps.maxTokenBudget,
      conversationSummary: deps.conversationSummary,
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
  async handleMessage(message: string, dashboardId?: string, signal?: AbortSignal): Promise<string> {
    this.emitAgentEvent(this.makeAgentEvent('agent.started', { dashboardId, message }));
    this.pendingConversationActions = []
    this.pendingNavigateTo = undefined

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

    const hasMetrics = this.deps.adapters.list({ signalType: 'metrics' }).length > 0
    const systemPrompt = buildSystemPrompt(dashboard ?? null, history, alertRules, activeAlertRule, this.deps.allDatasources ?? [], {
      hasPrometheus: hasMetrics,
      timeRange: this.deps.timeRange ? { start: this.deps.timeRange.start, end: this.deps.timeRange.end } : undefined,
      identity: this.deps.identity,
      permissionEscalationContact: this.deps.permissionEscalationContact,
      opsConnectors: this.deps.opsConnectors,
    })

    try {
      const result = await this.reactLoop.runLoop(
        systemPrompt,
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

  private async executeAction(step: ReActStep, _userMessage = ''): Promise<string | null> {
    const ctx = buildActionContext(this.deps, {
      sessionId: this.sessionId,
      actionExecutor: this.actionExecutor,
      alertRuleAgent: this.alertRuleAgent,
      emitAgentEvent: (event) => this.emitAgentEvent(event),
      makeAgentEvent: (type, metadata) => this.makeAgentEvent(type, metadata),
      pushConversationAction: (action) => this.pendingConversationActions.push(action),
      setNavigateTo: (path) => { this.pendingNavigateTo = path },
      investigationSections: this.investigationSections,
      activeInvestigationIdRef: this.activeInvestigationIdRef,
      activeDashboardIdRef: this.activeDashboardIdRef,
    })
    return this.actionRunner.execute(step, ctx)
  }
}
